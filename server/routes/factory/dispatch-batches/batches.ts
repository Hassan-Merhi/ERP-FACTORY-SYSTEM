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
import { parseId } from "../../../lib/parseId";
import { sql, eq, and } from "drizzle-orm";
import {
  customerDispatchBatches,
  customerDispatchTruckRides,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customers,
} from "@shared/schema";

import { getCompanyId, getUsername } from "./_helpers";
import { resultRows, firstRow } from "../../../lib/queryResult";
import { sqlArray } from "../../../lib/sqlArray";

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

  // ── POST /api/factory/dispatch-batches ────────────────────────────────────
  // Create a new dispatch batch (optionally linked to a proforma)
  app.post("/api/factory/dispatch-batches", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, proformaId, batchDate, destination, notes, currency, priceMode } = req.body;
      if (!customerId) return res.status(400).json({ message: "customerId is required" });
      if (!batchDate) return res.status(400).json({ message: "batchDate is required" });

      const result = await db.transaction(async (tx) => {
        // Validate customer
        const [customer] = await tx
          .select({ id: customers.id, legalName: customers.legalName })
          .from(customers)
          .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)));
        if (!customer) throw new Error("Customer not found");

        // Validate proforma if supplied
        let proforma = null;
        let proformaLines: unknown[] = [];
        if (proformaId) {
          const [pf] = await tx
            .select()
            .from(customerProformas)
            .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
          if (!pf) throw new Error("Proforma not found");
          if (pf.customerId !== customerId) throw new Error("Proforma belongs to a different customer");
          if (!["ACTIVE", "PARTIALLY_DISPATCHED"].includes(pf.status))
            throw new Error(`Proforma status is ${pf.status} — cannot create dispatch batch`);
          proforma = pf;
          proformaLines = await tx
            .select()
            .from(customerProformaLines)
            .where(eq(customerProformaLines.proformaId, proformaId));
        }

        // Generate batch number
        let seqRows = await tx.execute(
          sql`SELECT next_number FROM customer_dispatch_batch_sequences WHERE company_id = ${companyId} FOR UPDATE`
        );
        let seqRow = firstRow<{ next_number?: number; nextNumber?: number }>(seqRows);
        if (!seqRow) {
          await tx.execute(
            sql`INSERT INTO customer_dispatch_batch_sequences (company_id, next_number) VALUES (${companyId}, 1) ON CONFLICT (company_id) DO NOTHING`
          );
          seqRows = await tx.execute(
            sql`SELECT next_number FROM customer_dispatch_batch_sequences WHERE company_id = ${companyId} FOR UPDATE`
          );
          seqRow = firstRow<{ next_number?: number; nextNumber?: number }>(seqRows);
        }
        const nextNum = Number(seqRow?.next_number ?? seqRow?.nextNumber ?? 1);
        await tx.execute(
          sql`UPDATE customer_dispatch_batch_sequences SET next_number = ${nextNum + 1} WHERE company_id = ${companyId}`
        );
        const batchNumber = `DB-${String(nextNum).padStart(6, "0")}`;

        const [batch] = await tx
          .insert(customerDispatchBatches)
          .values({
            companyId,
            customerId,
            proformaId: proformaId || null,
            batchNumber,
            batchDate,
            status: "DRAFT",
            currency: currency || "USD",
            priceMode: priceMode || "PER_BALE",
            destination: destination || null,
            notes: notes || null,
            createdBy: getUsername(req),
          })
          .returning();

        return {
          batch,
          customerName: customer.legalName,
          proformaName: proforma?.name || null,
          proformaLines,
        };
      });

      res.status(201).json(result);
    } catch (err: unknown) {
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });

  // ── GET /api/factory/dispatch-batches/:id ─────────────────────────────────
  // Full detail: batch + proforma summary + rides + bale counts
  app.get("/api/factory/dispatch-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const batchId = parseId(req.params.id);
      if (batchId === null) return res.status(400).json({ message: "Invalid id" });

      const [batch] = await db
        .select()
        .from(customerDispatchBatches)
        .where(and(eq(customerDispatchBatches.id, batchId), eq(customerDispatchBatches.companyId, companyId)));
      if (!batch) return res.status(404).json({ message: "Dispatch batch not found" });

      const [customer] = await db
        .select({ legalName: customers.legalName })
        .from(customers)
        .where(eq(customers.id, batch.customerId));

      // Proforma + lines
      let proforma = null;
      let proformaLines: unknown[] = [];
      if (batch.proformaId) {
        const [pf] = await db.select().from(customerProformas).where(eq(customerProformas.id, batch.proformaId));
        if (pf) {
          proforma = pf;
          proformaLines = await db
            .select()
            .from(customerProformaLines)
            .where(eq(customerProformaLines.proformaId, batch.proformaId));
        }
      }

      // Truck rides with bale counts
      const rides = await db.execute(sql`
        SELECT
          tr.id,
          tr.ride_number AS "rideNumber",
          tr.truck_plate AS "truckPlate",
          tr.driver_name AS "driverName",
          tr.destination,
          tr.notes,
          tr.status,
          tr.loaded_at AS "loadedAt",
          tr.dispatched_at AS "dispatchedAt",
          tr.reopened_at AS "reopenedAt",
          tr.reopen_reason AS "reopenReason",
          tr.created_by AS "createdBy",
          tr.created_at AS "createdAt",
          COUNT(sc.id) FILTER (WHERE sc.removed_at IS NULL) AS "baleCount",
          COALESCE(SUM(sc.weight_kg) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalWeightKg",
          COALESCE(SUM(sc.amount) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalAmount"
        FROM customer_dispatch_truck_rides tr
        LEFT JOIN customer_dispatch_bale_scans sc ON sc.truck_ride_id = tr.id
        WHERE tr.batch_id = ${batchId} AND tr.company_id = ${companyId}
        GROUP BY tr.id
        ORDER BY tr.ride_number ASC
      `);

      // Scanned totals per article (for proforma progress)
      const articleTotals = await db.execute(sql`
        SELECT
          article_code AS "articleCode",
          product_name AS "productName",
          COUNT(*) FILTER (WHERE removed_at IS NULL) AS "scannedQty",
          COALESCE(SUM(weight_kg) FILTER (WHERE removed_at IS NULL), 0) AS "scannedWeightKg",
          COALESCE(SUM(amount) FILTER (WHERE removed_at IS NULL), 0) AS "scannedAmount"
        FROM customer_dispatch_bale_scans
        WHERE batch_id = ${batchId} AND company_id = ${companyId}
        GROUP BY article_code, product_name
      `);

      // Final invoice link
      let finalInvoice = null;
      if (batch.finalOrderId) {
        const [inv] = await db
          .select({
            id: customerOrders.id,
            invoiceNumber: customerOrders.invoiceNumber,
            grandTotal: customerOrders.grandTotal,
          })
          .from(customerOrders)
          .where(eq(customerOrders.id, batch.finalOrderId));
        finalInvoice = inv || null;
      }

      res.json({
        batch,
        customerName: customer?.legalName || null,
        proforma,
        proformaLines,
        rides: resultRows(rides),
        articleTotals: resultRows(articleTotals),
        finalInvoice,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── PATCH /api/factory/dispatch-batches/:id ───────────────────────────────
  // Update batch notes / destination / date (only while not INVOICED)
  app.patch("/api/factory/dispatch-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const batchId = parseId(req.params.id);
      if (batchId === null) return res.status(400).json({ message: "Invalid id" });

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
  });

  // ── DELETE /api/factory/dispatch-batches/:id ──────────────────────────────
  // Cancel a batch (returns bales to IN_STOCK)
  app.delete("/api/factory/dispatch-batches/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const batchId = parseId(req.params.id);
      if (batchId === null) return res.status(400).json({ message: "Invalid id" });

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
  });
}
