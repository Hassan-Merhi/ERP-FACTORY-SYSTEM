// Extracted from ./batches.ts
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { parseId } from "../../../lib/parseId";
import { sql, eq, and } from "drizzle-orm";
import {
  customerDispatchBatches,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customers,
} from "@shared/schema";
import { getCompanyId, getUsername } from "./_helpers";
import { resultRows, firstRow } from "../../../lib/queryResult";

export function registerDispatchBatchCrudRoutesPart1(app: Express) {
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
}
