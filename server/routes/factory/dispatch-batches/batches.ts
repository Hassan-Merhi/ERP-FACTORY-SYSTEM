/**
 * factoryDispatchBatchRoutes: DispatchBatchCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  idParams,
  validateRequest,
  validatedInput,
  type RequestSchemas,
} from "../../../lib/validateRequest";
import { sql, eq, and } from "drizzle-orm";
import { customerDispatchBatches, customerDispatchTruckRides } from "@shared/schema";

import { getCompanyId } from "./_helpers";
import { resultRows } from "../../../lib/queryResult";
import { sqlArray } from "../../../lib/sqlArray";
import { registerDispatchBatchCrudRoutesPart1 } from "./registerDispatchBatchCrudRoutesPart1";

const optionalText = z.string().nullable().optional();

const updateBatchInput = {
  params: idParams,
  query: emptyQuery,
  body: z.strictObject({ notes: optionalText, destination: optionalText, batchDate: z.string().optional() }),
} satisfies RequestSchemas;

const cancelBatchInput = { params: idParams, query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerDispatchBatchCrudRoutes(app: Express) {
  // ── GET /api/factory/dispatch-batches ─────────────────────────────────────
  // List all batches for the company with optional filters
  app.get("/api/factory/dispatch-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { status, customerId } = req.query;

      const rows = await db.execute(sql`
        SELECT
          b.id,
          b.batch_number AS "batchNumber",
          b.batch_date AS "batchDate",
          b.status,
          b.currency,
          b.price_mode AS "priceMode",
          b.destination,
          b.notes,
          b.final_order_id AS "finalOrderId",
          b.created_by AS "createdBy",
          b.created_at AS "createdAt",
          b.updated_at AS "updatedAt",
          b.cancelled_at AS "cancelledAt",
          b.customer_id AS "customerId",
          b.proforma_id AS "proformaId",
          c.legal_name AS "customerName",
          p.name AS "proformaName",
          COUNT(DISTINCT tr.id) FILTER (WHERE tr.id IS NOT NULL) AS "rideCount",
          COUNT(DISTINCT sc.id) FILTER (WHERE sc.id IS NOT NULL AND sc.removed_at IS NULL) AS "baleCount",
          COALESCE(SUM(sc.weight_kg) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalWeightKg",
          COALESCE(SUM(sc.amount) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalAmount",
          co.invoice_number AS "invoiceNumber"
        FROM customer_dispatch_batches b
        LEFT JOIN customers c ON c.id = b.customer_id
        LEFT JOIN customer_proformas p ON p.id = b.proforma_id
        LEFT JOIN customer_dispatch_truck_rides tr ON tr.batch_id = b.id
        LEFT JOIN customer_dispatch_bale_scans sc ON sc.batch_id = b.id
        LEFT JOIN customer_orders co ON co.id = b.final_order_id
        WHERE b.company_id = ${companyId}
          ${status ? sql`AND b.status = ${status}` : sql``}
          ${customerId ? sql`AND b.customer_id = ${parseInt(customerId as string)}` : sql``}
        GROUP BY b.id, c.legal_name, p.name, co.invoice_number
        ORDER BY b.created_at DESC
      `);

      res.json(resultRows(rows));
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  registerDispatchBatchCrudRoutesPart1(app);

  // ── PATCH /api/factory/dispatch-batches/:id ───────────────────────────────
  // Update batch notes / destination / date (only while not INVOICED)
  app.patch(
    "/api/factory/dispatch-batches/:id",
    requireAuth,
    validateRequest(updateBatchInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const batchId = validatedInput(req, updateBatchInput).params.id;

        const [batch] = await db
          .select()
          .from(customerDispatchBatches)
          .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
        if (!batch) return res.status(404).json({ message: "Batch not found" });
        if (batch.status === "INVOICED") return res.status(400).json({ message: "Cannot edit an invoiced batch" });
        if (batch.status === "CANCELLED") return res.status(400).json({ message: "Cannot edit a cancelled batch" });

        const { notes, destination, batchDate } = req.body;
        const updates: Partial<typeof customerDispatchBatches.$inferInsert> = { updatedAt: new Date() };
        if (notes !== undefined) updates.notes = notes;
        if (destination !== undefined) updates.destination = destination;
        if (batchDate !== undefined) updates.batchDate = batchDate;

        const [updated] = await db
          .update(customerDispatchBatches)
          .set(updates)
          .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)))
          .returning();
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // ── DELETE /api/factory/dispatch-batches/:id ──────────────────────────────
  // Cancel a batch (returns bales to IN_STOCK)
  app.delete(
    "/api/factory/dispatch-batches/:id",
    requireAuth,
    validateRequest(cancelBatchInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = getCompanyId(req);
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const batchId = validatedInput(req, cancelBatchInput).params.id;

        await db.transaction(async (tx) => {
          const [batch] = await tx
            .select()
            .from(customerDispatchBatches)
            .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
          if (!batch) throw new Error("Batch not found");
          if (batch.status === "INVOICED") throw new Error("Cannot cancel an invoiced batch");
          if (batch.status === "CANCELLED") throw new Error("Batch already cancelled");

          // Return all reserved bales to IN_STOCK
          const activeBaleIds = await tx.execute(sql`
          SELECT bale_id FROM customer_dispatch_bale_scans
          WHERE batch_id = ${batchId} AND company_id = ${companyId} AND removed_at IS NULL
        `);
          const ids = resultRows(activeBaleIds).map((r) => Number(r.bale_id));
          if (ids.length > 0) {
            // sqlArray, not a bare array: Drizzle renders a bare JS array as
            // tuple syntax, which ANY() rejects outright — so this statement used
            // to throw for every batch that had a bale on it, which is every
            // batch worth cancelling.
            await tx.execute(sql`
            UPDATE factory_bales SET status = 'IN_STOCK', updated_at = now()
            WHERE id = ANY(${sqlArray(ids)}) AND status = 'RESERVED_FOR_DISPATCH'
          `);
          }

          // Cancel all rides
          await tx
            .update(customerDispatchTruckRides)
            .set({ status: "CANCELLED", updatedAt: new Date() })
            .where(
              and(eq(customerDispatchTruckRides.batchId, batchId), eq(customerDispatchTruckRides.companyId, companyId))
            );

          // Mark batch cancelled
          await tx
            .update(customerDispatchBatches)
            .set({ status: "CANCELLED", cancelledAt: new Date(), updatedAt: new Date() })
            .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
        });

        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(400).json({ message: getErrorMessage(err) });
      }
    }
  );
}
