/**
 * factoryStockAllocationV5Routes: V5ProformaUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { customerProformas } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringParam,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";

const proformaIdParams = z.strictObject({ proformaId: stringParam });

const closeProformaInput = { params: proformaIdParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

// The handler keeps its per-entry checks and messages.
const draftExpectedLinesInput = {
  params: proformaIdParams,
  query: emptyQuery,
  body: z.strictObject({
    updates: z
      .array(
        z.strictObject({
          articleCode: z.string().optional(),
          expectedQty: z.union([z.number(), z.string()]).optional(),
        })
      )
      .optional(),
  }),
} satisfies RequestSchemas;

export function registerV5ProformaUpdateRoutes(app: Express) {
  // ── PATCH /api/factory/v5/proforma/:proformaId/close ─────────────────────
  // Manually closes an active proforma by setting isActive = false.
  // Validates all linked containers are FINALIZED or CANCELLED before closing.
  // After close the proforma no longer appears in the V5 GET (which filters isActive=true),
  // so it stops contributing to expectedToLoad automatically.
  // Does NOT delete proformas, containers, expected lines, or bales.
  // V5 guard: proformaIdUsed IS NOT NULL (proforma.isActive is V5-specific concept)
  app.patch(
    "/api/factory/v5/proforma/:proformaId/close",
    requireAuth,
    validateRequest(closeProformaInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const proformaId = parseInt(validatedInput(req, closeProformaInput).params.proformaId);
        if (!proformaId || isNaN(proformaId)) return res.status(400).json({ message: "Invalid proformaId" });

        // Confirm proforma exists for this company
        const [proforma] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });
        if (!proforma.isActive) return res.status(400).json({ message: "Proforma is already closed" });

        // Confirm it has linked customer_orders
        const linkedOrdersRaw = await db.execute(
          sql`SELECT id, status FROM customer_orders WHERE proforma_id_used = ${proformaId}`
        );
        const linkedOrders = resultRows(linkedOrdersRaw) as { id: number; status: string }[];
        if (linkedOrders.length === 0) {
          return res.status(400).json({ message: "Cannot close a proforma with no linked containers" });
        }

        // Confirm all linked orders are FINALIZED or CANCELLED
        const CLOSEABLE_STATUSES = ["FINALIZED", "CANCELLED"];
        const openOrders = linkedOrders.filter((o) => !CLOSEABLE_STATUSES.includes(o.status));
        if (openOrders.length > 0) {
          return res.status(400).json({ message: "Cannot close proforma while containers are still open." });
        }

        // Set isActive = false — proforma disappears from the V5 GET active filter automatically
        const [updated] = await db
          .update(customerProformas)
          .set({ isActive: false })
          .where(eq(customerProformas.id, proformaId))
          .returning();

        res.json({ proforma: updated });
      } catch (err: unknown) {
        logger.error("[V5] close-proforma error:", { error: err });
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── PATCH /api/factory/v5/proforma/:proformaId/draft-expected-lines ───────
  // Updates expected_qty in customer_order_expected_lines for DRAFT containers
  // that have NOT started loading (zero bales in customer_order_bales).
  // Containers that have any scanned bale, or whose status is not DRAFT, are
  // completely untouched. V2/V3 orders are not affected (V5 guard below).
  // V5 guard: proformaIdUsed IS NOT NULL (eligible query requires proforma_id_used = proformaId)
  app.patch(
    "/api/factory/v5/proforma/:proformaId/draft-expected-lines",
    requireAuth,
    validateRequest(draftExpectedLinesInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const proformaId = parseInt(validatedInput(req, draftExpectedLinesInput).params.proformaId);
        if (!proformaId || isNaN(proformaId)) return res.status(400).json({ message: "Invalid proformaId" });

        const { updates } = req.body as { updates?: { articleCode: string; expectedQty: number }[] };
        if (!Array.isArray(updates) || updates.length === 0) {
          return res.status(400).json({ message: "updates[] is required and must not be empty" });
        }

        // Validate each update entry before touching the DB
        for (const u of updates) {
          if (!u.articleCode || typeof u.articleCode !== "string") {
            return res.status(400).json({ message: "Each update must have a valid articleCode" });
          }
          if (!Number.isInteger(Number(u.expectedQty)) || Number(u.expectedQty) < 0) {
            return res
              .status(400)
              .json({ message: `expectedQty for "${u.articleCode}" must be a non-negative integer` });
          }
        }

        // Verify proforma exists and is active for this company
        const [proforma] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });
        if (!proforma.isActive) return res.status(400).json({ message: "Proforma is closed" });

        // Find eligible DRAFT orders: status = DRAFT AND NOT EXISTS bales row
        // This is the core safety gate — any container with even one scanned bale is excluded.
        // V5 guard: proformaIdUsed IS NOT NULL (proforma_id_used = proformaId ensures this)
        const eligibleRaw = await db.execute(
          sql`SELECT id FROM customer_orders
            WHERE company_id = ${companyId}
              AND proforma_id_used = ${proformaId}
              AND status = 'DRAFT'
              AND NOT EXISTS (
                SELECT 1 FROM customer_order_bales cob WHERE cob.order_id = customer_orders.id
              )`
        );
        const eligibleOrders = resultRows(eligibleRaw) as { id: number }[];
        if (eligibleOrders.length === 0) {
          return res.status(400).json({ message: "No draft containers are available to edit." });
        }
        const eligibleIds = eligibleOrders.map((o) => Number(o.id));

        // Update expected_qty per article × per eligible order.
        // Only updates rows that ALREADY EXIST — rejects silently for unknown articles
        // (expected lines are backfilled at GET time, so missing rows = article not in proforma).
        // LOADING / PENDING / VERIFIED / FINALIZED / CANCELLED orders are not in eligibleIds,
        // so their expected lines are guaranteed to remain unchanged.
        let totalUpdated = 0;
        await db.transaction(async (tx) => {
          for (const update of updates) {
            const qty = Math.round(Number(update.expectedQty));
            for (const orderId of eligibleIds) {
              const result = await tx.execute(
                sql`UPDATE customer_order_expected_lines
                  SET expected_qty = ${qty}
                  WHERE order_id = ${orderId}
                    AND article_code = ${update.articleCode}
                    AND company_id = ${companyId}`
              );
              totalUpdated += result.rowCount ?? 0;
            }
          }
        });

        res.json({
          updated: totalUpdated,
          eligibleContainers: eligibleIds.length,
          articlesEdited: updates.length,
        });
      } catch (err: unknown) {
        logger.error("[V5] draft-expected-lines error:", { error: err });
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );
}
