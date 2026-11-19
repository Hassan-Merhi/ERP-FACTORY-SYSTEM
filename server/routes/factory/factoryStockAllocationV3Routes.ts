import type { Express, Request, Response } from "express";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { factoryV3Loads, factoryV3LoadBales } from "@shared/schema";
import { requireAuth } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { FactoryInvoiceRateRefusalError } from "../../services/accounting/perpetualInventory/factoryInvoice";
import { V3LoadFinalizeRefusalError, finalizeV3LoadTx } from "../../services/factory/v3LoadInvoice";
import {
  getCompanyId,
  getUserInfo,
  registerFactoryStockAllocationV3RoutesPart1,
  v3LoadActionInput,
} from "./registerFactoryStockAllocationV3RoutesPart1";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  stringParam,
  validateRequest,
  type RequestSchemas,
} from "../../lib/validateRequest";

const scanBaleInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({ scanCode: z.string().nullable().optional(), bypass: z.boolean().nullable().optional() }),
} satisfies RequestSchemas;

const removeLoadBaleInput = {
  params: z.strictObject({ id: stringParam, baleId: stringParam }),
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

export function registerFactoryStockAllocationV3Routes(app: Express) {
  registerFactoryStockAllocationV3RoutesPart1(app);
  registerFactoryStockAllocationV3RoutesPart2(app);
}

function registerFactoryStockAllocationV3RoutesPart2(app: Express) {
  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads/:id/bales — scan bale into load
  // Same matching logic as existing system: referenceNumber, baleCode, articleCode
  // ──────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/v3/loads/:id/bales",
    requireAuth,
    validateRequest(scanBaleInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const loadId = parseId(req.params.id);
        if (loadId === null) return res.status(400).json({ message: "Invalid id" });
        const { scanCode, bypass } = req.body;
        if (!scanCode) return res.status(400).json({ message: "scanCode is required" });

        const [load] = await db
          .select()
          .from(factoryV3Loads)
          .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)));
        if (!load) return res.status(404).json({ message: "Load not found" });
        if (load.status !== "loading")
          return res.status(400).json({ message: "Can only scan bales into a load that is currently Loading" });

        const scanLower = scanCode.toLowerCase().trim();

        type ScannedBaleRow = {
          id: number;
          baleCode: string;
          referenceNumber: string;
          articleCode: string;
          productName: string;
          weightKg: string;
          status: string;
        };

        // Find the bale by referenceNumber, baleCode, articleCode (pick ONE bale — prefer IN_STOCK)
        const balesFound = await db.execute(sql`
        SELECT id, bale_code AS "baleCode", reference_number AS "referenceNumber",
               article_code AS "articleCode", product_name AS "productName",
               weight_kg AS "weightKg", status
        FROM factory_bales
        WHERE company_id = ${companyId}
          AND (
            LOWER(reference_number) = ${scanLower}
            OR LOWER(bale_code) = ${scanLower}
          )
        ORDER BY
          CASE status WHEN 'IN_STOCK' THEN 0 WHEN 'RESERVED_FOR_ORDER' THEN 1 ELSE 2 END
        LIMIT 1
      `);

        let bale = balesFound.rows[0] as ScannedBaleRow | undefined;

        // If not found by ref/baleCode, try articleCode (adds one IN_STOCK bale of that article)
        if (!bale) {
          const byArticle = await db.execute(sql`
          SELECT id, bale_code AS "baleCode", reference_number AS "referenceNumber",
                 article_code AS "articleCode", product_name AS "productName",
                 weight_kg AS "weightKg", status
          FROM factory_bales
          WHERE company_id = ${companyId}
            AND LOWER(article_code) = ${scanLower}
            AND status = 'IN_STOCK'
          ORDER BY id
          LIMIT 1
        `);
          bale = byArticle.rows[0] as ScannedBaleRow | undefined;
        }

        if (!bale) return res.status(404).json({ message: `No bale found for scan code: ${scanCode}` });

        // Block if already SOLD/SHIPPED
        if (bale.status === "SOLD" || bale.status === "SHIPPED") {
          return res
            .status(400)
            .json({ message: `Bale ${bale.referenceNumber} is already ${bale.status} and cannot be loaded` });
        }

        // Warn if already in this v3 load (not removed)
        const alreadyInLoad = await db.execute(sql`
        SELECT id FROM factory_v3_load_bales
        WHERE load_id = ${loadId} AND bale_id = ${bale.id} AND removed_at IS NULL
      `);
        if (alreadyInLoad.rows.length > 0) {
          return res.status(400).json({ message: `Bale ${bale.referenceNumber} is already in this load` });
        }

        // Warn if RESERVED_FOR_ORDER (old system) — allow bypass
        if (bale.status === "RESERVED_FOR_ORDER" && !bypass) {
          return res.status(409).json({
            code: "RESERVED_WARNING",
            message: `Bale ${bale.referenceNumber} is reserved for another loading order. Scan again to confirm.`,
            bale,
          });
        }

        // Warn if bale is already in another active v3 load (not removed)
        const inOtherV3 = await db.execute(sql`
        SELECT lb.id, l.load_name AS "loadName"
        FROM factory_v3_load_bales lb
        JOIN factory_v3_loads l ON l.id = lb.load_id
        WHERE lb.bale_id = ${bale.id}
          AND lb.removed_at IS NULL
          AND lb.load_id <> ${loadId}
          AND l.status IN ('expected_to_load', 'loading')
          AND l.company_id = ${companyId}
        LIMIT 1
      `);
        const otherV3 = inOtherV3.rows[0];
        if (otherV3 && !bypass) {
          return res.status(409).json({
            code: "OTHER_V3_LOAD_WARNING",
            message: `Bale ${bale.referenceNumber} is already assigned to v3 load "${otherV3.loadName}". Scan again to confirm.`,
            bale,
          });
        }

        const user = getUserInfo(req);
        const [added] = await db
          .insert(factoryV3LoadBales)
          .values({
            loadId,
            baleId: bale.id,
            baleReference: bale.referenceNumber || bale.baleCode,
            articleCode: bale.articleCode,
            productName: bale.productName,
            weightKg: bale.weightKg,
            phase: "scanned",
            addedBy: user.id,
            addedByName: user.name,
          })
          .returning();

        res.status(201).json({ ...added, baleStatus: bale.status });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // DELETE /api/factory/v3/loads/:id/bales/:baleId — soft-remove
  // ──────────────────────────────────────────────────────────────
  app.delete(
    "/api/factory/v3/loads/:id/bales/:baleId",
    requireAuth,
    validateRequest(removeLoadBaleInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const loadId = parseId(req.params.id);
        if (loadId === null) return res.status(400).json({ message: "Invalid id" });
        const lbId = parseId(req.params.baleId);
        if (lbId === null) return res.status(400).json({ message: "Invalid id" });

        const [load] = await db
          .select()
          .from(factoryV3Loads)
          .where(and(eq(factoryV3Loads.id, loadId), eq(factoryV3Loads.companyId, companyId)));
        if (!load) return res.status(404).json({ message: "Load not found" });
        if (load.status === "finalized")
          return res.status(400).json({ message: "Cannot remove bales from a finalized load" });

        const user = getUserInfo(req);
        await db
          .update(factoryV3LoadBales)
          .set({ removedAt: new Date(), removedBy: user.id, removedByName: user.name })
          .where(and(eq(factoryV3LoadBales.id, lbId), eq(factoryV3LoadBales.loadId, loadId)));

        res.json({ ok: true });
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // POST /api/factory/v3/loads/:id/finalize
  // Invoices the load and marks its live bales SOLD, in one transaction
  // (wave 17 B, services/factory/v3LoadInvoice.ts). Re-finalize is idempotent.
  // ──────────────────────────────────────────────────────────────
  app.post(
    "/api/factory/v3/loads/:id/finalize",
    requireAuth,
    requireFactoryTabAccess("factory/invoicing", "hide_invoicing_invoices_tab"),
    validateRequest(v3LoadActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const result = await db.transaction((tx) =>
          finalizeV3LoadTx(tx, {
            companyId,
            loadId: id,
            user: getUserInfo(req),
            statementDate: getClientDate(req),
          })
        );
        res.json({ ...result.load, invoice: result.invoice, alreadyFinalized: result.alreadyFinalized });
      } catch (e: unknown) {
        if (e instanceof V3LoadFinalizeRefusalError) return res.status(e.statusCode).json(e.body);
        if (e instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(e.body);
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // PATCH /api/factory/v3/loads/:id/cancel
  // ──────────────────────────────────────────────────────────────
  app.patch(
    "/api/factory/v3/loads/:id/cancel",
    requireAuth,
    validateRequest(v3LoadActionInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const id = parseId(req.params.id);
        if (id === null) return res.status(400).json({ message: "Invalid id" });

        const [load] = await db
          .select()
          .from(factoryV3Loads)
          .where(and(eq(factoryV3Loads.id, id), eq(factoryV3Loads.companyId, companyId)));
        if (!load) return res.status(404).json({ message: "Load not found" });
        if (load.status === "finalized") return res.status(400).json({ message: "Cannot cancel a finalized load" });

        const [updated] = await db
          .update(factoryV3Loads)
          .set({ status: "cancelled", cancelledAt: new Date() })
          .where(eq(factoryV3Loads.id, id))
          .returning();

        res.json(updated);
      } catch (e: unknown) {
        res.status(500).json({ message: getErrorMessage(e) });
      }
    }
  );

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/proformas
  // Active proformas with line counts + linked v3 load summary
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/proformas", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        SELECT
          p.id,
          p.name,
          p.is_active       AS "isActive",
          p.created_at      AS "createdAt",
          cu.id             AS "customerId",
          cu.legal_name     AS "customerName",
          COALESCE(pl.line_count, 0) AS "lineCount",
          COALESCE(pl.total_qty, 0)  AS "totalQty",
          COALESCE(vl.load_count, 0) AS "v3LoadCount",
          COALESCE(vl.active_count, 0) AS "v3ActiveCount"
        FROM customer_proformas p
        JOIN customers cu ON cu.id = p.customer_id
        LEFT JOIN (
          SELECT proforma_id,
                 COUNT(*)::int AS line_count,
                 SUM(quantity)::int AS total_qty
          FROM customer_proforma_lines
          GROUP BY proforma_id
        ) pl ON pl.proforma_id = p.id
        LEFT JOIN (
          SELECT proforma_id,
                 COUNT(*)::int AS load_count,
                 COUNT(*) FILTER (WHERE status IN ('expected_to_load','loading'))::int AS active_count
          FROM factory_v3_loads
          WHERE company_id = ${companyId}
          GROUP BY proforma_id
        ) vl ON vl.proforma_id = p.id
        WHERE p.company_id = ${companyId}
          AND p.is_active = true
        ORDER BY p.created_at DESC
      `);

      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ──────────────────────────────────────────────────────────────
  // GET /api/factory/v3/proformas/:id/loads
  // All v3 loads linked to a specific proforma
  // ──────────────────────────────────────────────────────────────
  app.get("/api/factory/v3/proformas/:id/loads", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const proformaId = parseId(req.params.id);
      if (proformaId === null) return res.status(400).json({ message: "Invalid id" });

      const result = await db.execute(sql`
        SELECT l.id, l.load_name AS "loadName", l.status,
               l.expected_load_date AS "expectedLoadDate",
               l.created_at AS "createdAt",
               l.finalized_at AS "finalizedAt",
               COUNT(lb.id) FILTER (WHERE lb.removed_at IS NULL)::int AS "baleCount"
        FROM factory_v3_loads l
        LEFT JOIN factory_v3_load_bales lb ON lb.load_id = l.id
        WHERE l.company_id = ${companyId} AND l.proforma_id = ${proformaId}
        GROUP BY l.id
        ORDER BY l.created_at DESC
      `);

      res.json(result.rows);
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}
