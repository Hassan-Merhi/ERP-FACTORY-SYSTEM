/**
 * factoryDispatchBatchRoutes: DispatchInvoice endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { parseId } from "../../../lib/parseId";
import { getClientDate } from "../../../lib/dateUtils";
import { sql, eq, and } from "drizzle-orm";
import {
  customerDispatchBatches,
  customerDispatchTruckRides,
  customerProformas,
  customerProformaLines,
  customers,
} from "@shared/schema";

import { getCompanyId } from "./_helpers";
import { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";
import { firstRow, resultRows } from "../../../lib/queryResult";

type RawProformaLineRow = { article_code: string; quantity: number };

export function registerDispatchInvoiceRoutes(app: Express) {
  // ── GET /api/factory/dispatch-batches/:id/invoice-preview ─────────────────
  // Preview the final invoice before generation — proforma-aware
  app.get("/api/factory/dispatch-batches/:id/invoice-preview", requireAuth, async (req: Request, res: Response) => {
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
      if (batch.status === "INVOICED") return res.status(400).json({ message: "Batch already invoiced" });
      if (batch.status === "CANCELLED") return res.status(400).json({ message: "Batch is cancelled" });

      const [customer] = await db.select().from(customers).where(eq(customers.id, batch.customerId));

      // Proforma info
      let proforma = null;
      let proformaLines: (typeof customerProformaLines.$inferSelect)[] = [];
      if (batch.proformaId) {
        const rows = await db.select().from(customerProformas).where(eq(customerProformas.id, batch.proformaId));
        proforma = rows[0] || null;
        proformaLines = await db
          .select()
          .from(customerProformaLines)
          .where(eq(customerProformaLines.proformaId, batch.proformaId));
      }

      // Check for blocking conditions
      const allRides = await db
        .select()
        .from(customerDispatchTruckRides)
        .where(
          and(eq(customerDispatchTruckRides.batchId, batchId), eq(customerDispatchTruckRides.companyId, companyId))
        );

      const loadingRides = allRides.filter((r) => r.status === "LOADING" || r.status === "DRAFT");
      const dispatchedRides = allRides.filter((r) => r.status === "DISPATCHED");

      // Scanned bales grouped by article (active scans only)
      const articleSummary = await db.execute(sql`
        SELECT
          sc.article_code AS "articleCode",
          sc.product_name AS "productName",
          COUNT(*) AS "qty",
          COALESCE(SUM(sc.weight_kg), 0) AS "totalWeightKg",
          sc.price_used AS "pricePerBale",
          COALESCE(SUM(sc.amount), 0) AS "totalAmount"
        FROM customer_dispatch_bale_scans sc
        WHERE sc.batch_id = ${batchId} AND sc.company_id = ${companyId} AND sc.removed_at IS NULL
        GROUP BY sc.article_code, sc.product_name, sc.price_used
        ORDER BY sc.article_code
      `);
      const articleRows = resultRows<{
        articleCode: string;
        qty: string | null;
        totalAmount: string | null;
      }>(articleSummary);

      // Total scans
      const totalRows = await db.execute(sql`
        SELECT
          COUNT(*) AS "totalBales",
          COALESCE(SUM(weight_kg), 0) AS "totalWeightKg",
          COALESCE(SUM(amount), 0) AS "grandTotal"
        FROM customer_dispatch_bale_scans
        WHERE batch_id = ${batchId} AND company_id = ${companyId} AND removed_at IS NULL
      `);
      const totals = firstRow<{ totalBales: string | null }>(totalRows);

      // Mismatch warnings (bales with article codes not in the proforma)
      const mismatchRows = await db.execute(sql`
        SELECT DISTINCT sc.article_code AS "articleCode"
        FROM customer_dispatch_bale_scans sc
        WHERE sc.batch_id = ${batchId} AND sc.company_id = ${companyId} AND sc.removed_at IS NULL
          AND sc.article_code IS NOT NULL
          ${
            batch.proformaId
              ? sql`AND sc.article_code NOT IN (
                SELECT article_code FROM customer_proforma_lines WHERE proforma_id = ${batch.proformaId}
              )`
              : sql`AND 1=0`
          }
      `);
      const mismatches = resultRows(mismatchRows).map((r) => r.articleCode);

      // Proforma progress per article
      const proformaProgress = proformaLines.map((pl) => {
        const scanned = articleRows.find((a) => a.articleCode === pl.articleCode);
        return {
          articleCode: pl.articleCode,
          productName: pl.productName,
          proformaQty: pl.quantity,
          proformaPrice: pl.pricePerBale,
          scannedQty: parseInt(scanned?.qty || "0"),
          remaining: pl.quantity - parseInt(scanned?.qty || "0"),
          totalAmount: scanned?.totalAmount || "0",
        };
      });

      // Ride summary
      const rideSummary = await db.execute(sql`
        SELECT
          tr.id,
          tr.ride_number AS "rideNumber",
          tr.truck_plate AS "truckPlate",
          tr.driver_name AS "driverName",
          tr.status,
          COUNT(sc.id) FILTER (WHERE sc.removed_at IS NULL) AS "baleCount",
          COALESCE(SUM(sc.weight_kg) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalWeightKg",
          COALESCE(SUM(sc.amount) FILTER (WHERE sc.removed_at IS NULL), 0) AS "totalAmount"
        FROM customer_dispatch_truck_rides tr
        LEFT JOIN customer_dispatch_bale_scans sc ON sc.truck_ride_id = tr.id
        WHERE tr.batch_id = ${batchId} AND tr.company_id = ${companyId}
        GROUP BY tr.id
        ORDER BY tr.ride_number
      `);

      res.json({
        batch,
        customer: { id: customer?.id, legalName: customer?.legalName },
        proforma,
        proformaProgress,
        rides: resultRows(rideSummary),
        articleLines: articleRows,
        totals,
        loadingRides: loadingRides.length,
        dispatchedRides: dispatchedRides.length,
        totalRides: allRides.length,
        blockers:
          loadingRides.length > 0
            ? [
                `${loadingRides.length} truck ride(s) are still in LOADING status. All rides must be DISPATCHED before generating an invoice.`,
              ]
            : [],
        mismatchedArticles: mismatches,
        canGenerate: parseInt(totals?.totalBales || "0") > 0 && loadingRides.length === 0,
      });
    } catch (err: unknown) {
      res.status(500).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/factory/dispatch-batches/:id/generate-invoice ───────────────
  // Generate one final invoice from all dispatched truck rides
  app.post("/api/factory/dispatch-batches/:id/generate-invoice", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const batchId = parseId(req.params.id);
      if (batchId === null) return res.status(400).json({ message: "Invalid id" });

      const { invoiceDate } = req.body;

      const result = await db.transaction(async (tx) => {
        // Invoicing consumes this batch's proforma capacity, so it serializes
        // against scanners and imports on the same proforma. Take the proforma
        // lock before the batch row lock, the ordering every protected path
        // follows, using an unlocked read for the id. The authoritative id from
        // the locked row is re-locked below in case it changed in between;
        // pg_advisory_xact_lock is re-entrant, so locking the same one twice is
        // free.
        const preBatchRows = await tx.execute(sql`
          SELECT proforma_id FROM customer_dispatch_batches
          WHERE id = ${batchId} AND company_id = ${companyId}
        `);
        const preBatchProformaId = resultRows(preBatchRows)[0]?.proforma_id;
        if (preBatchProformaId) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: Number(preBatchProformaId),
          });
        }

        // 1. Lock and validate batch
        const batchRows = await tx.execute(sql`
          SELECT * FROM customer_dispatch_batches
          WHERE id = ${batchId} AND company_id = ${companyId} FOR UPDATE
        `);
        const batch = resultRows(batchRows)[0];
        if (!batch) throw new Error("Dispatch batch not found");
        if (batch.status === "INVOICED") throw new Error("Batch already invoiced");
        if (batch.status === "CANCELLED") throw new Error("Batch is cancelled");

        if (batch.proforma_id && Number(batch.proforma_id) !== Number(preBatchProformaId)) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: Number(batch.proforma_id),
          });
        }

        // 2. Check proforma status
        let proforma = null;
        let proformaLines: RawProformaLineRow[] = [];
        if (batch.proforma_id) {
          const pfRows = await tx.execute(
            sql`SELECT * FROM customer_proformas WHERE id = ${batch.proforma_id} FOR UPDATE`
          );
          proforma = resultRows(pfRows)[0];
          if (!proforma) throw new Error("Linked proforma not found");
          if (proforma.status === "CANCELLED")
            throw new Error("Linked proforma is CANCELLED — cannot generate invoice");
          if (proforma.status === "FULLY_INVOICED")
            throw new Error("Linked proforma is FULLY_INVOICED — cannot generate another invoice");
          const plRows = await tx.execute(
            sql`SELECT * FROM customer_proforma_lines WHERE proforma_id = ${batch.proforma_id}`
          );
          proformaLines = resultRows<RawProformaLineRow>(plRows);
        }

        // 3. Check all rides are DISPATCHED
        const rideRows = await tx.execute(sql`
          SELECT id, status FROM customer_dispatch_truck_rides
          WHERE batch_id = ${batchId} AND company_id = ${companyId}
        `);
        const rides = resultRows(rideRows);
        const loadingRides = rides.filter((r) => r.status === "LOADING" || r.status === "DRAFT");
        if (loadingRides.length > 0)
          throw new Error(
            `${loadingRides.length} ride(s) are still in LOADING status. All rides must be DISPATCHED first.`
          );

        // 4. Load all active bale scans
        const scanRows = await tx.execute(sql`
          SELECT * FROM customer_dispatch_bale_scans
          WHERE batch_id = ${batchId} AND company_id = ${companyId} AND removed_at IS NULL
        `);
        const scans = resultRows<{
          bale_id: number;
          bale_reference: string | null;
          scanned_by: string | null;
          article_code: string | null;
          product_name: string | null;
          weight_kg: string | null;
          price_used: string | null;
          amount: string | null;
        }>(scanRows);
        if (scans.length === 0) throw new Error("No scanned bales found in this batch");

        // 5. Assign invoice number
        let seqRows = await tx.execute(sql`
          SELECT * FROM customer_invoice_sequences WHERE company_id = ${companyId} FOR UPDATE
        `);
        let seqRow = firstRow<{ next_number?: number; nextNumber?: number }>(seqRows);
        if (!seqRow) {
          await tx.execute(
            sql`INSERT INTO customer_invoice_sequences (company_id, next_number) VALUES (${companyId}, 1) ON CONFLICT DO NOTHING`
          );
          seqRows = await tx.execute(
            sql`SELECT * FROM customer_invoice_sequences WHERE company_id = ${companyId} FOR UPDATE`
          );
          seqRow = firstRow<{ next_number?: number; nextNumber?: number }>(seqRows);
        }
        const invoiceNum = Number(seqRow?.next_number ?? seqRow?.nextNumber ?? 0);
        await tx.execute(
          sql`UPDATE customer_invoice_sequences SET next_number = ${invoiceNum + 1} WHERE company_id = ${companyId}`
        );
        const invoiceNumber = `INV-${String(invoiceNum).padStart(6, "0")}`;

        // 6. Build grouped order lines by articleCode
        const lineMap = new Map<
          string,
          {
            articleCode: string;
            baleName: string;
            qty: number;
            totalWeight: number;
            pricePerBale: number;
            totalPrice: number;
          }
        >();
        for (const scan of scans) {
          const key = scan.article_code || "UNKNOWN";
          const existing = lineMap.get(key);
          const weight = parseFloat(scan.weight_kg || "0");
          const price = parseFloat(scan.price_used || "0");
          if (existing) {
            existing.qty += 1;
            existing.totalWeight += weight;
            existing.totalPrice += parseFloat(scan.amount || "0");
          } else {
            lineMap.set(key, {
              articleCode: key,
              baleName: scan.product_name || key,
              qty: 1,
              totalWeight: weight,
              pricePerBale: price,
              totalPrice: parseFloat(scan.amount || "0"),
            });
          }
        }
        const lines = Array.from(lineMap.values());

        const grandTotal = lines.reduce((sum, l) => sum + l.totalPrice, 0);
        const totalQtyBales = scans.length;
        const orderDate = invoiceDate || batch.batch_date || getClientDate(req as Request);

        // 7. Create customerOrders row (FINALIZED immediately)
        const orderRows = await tx.execute(sql`
          INSERT INTO customer_orders (
            company_id, customer_id, invoice_number, order_date, proforma_id_used,
            status, subtotal_bales, freight_amount, other_charges_total, grand_total,
            total_qty_bales, dispatch_batch_id, created_at, updated_at
          ) VALUES (
            ${companyId}, ${batch.customer_id}, ${invoiceNumber}, ${orderDate},
            ${batch.proforma_id || null},
            'FINALIZED',
            ${grandTotal.toFixed(2)}, '0', '0', ${grandTotal.toFixed(2)},
            ${totalQtyBales},
            ${batchId},
            now(), now()
          ) RETURNING *
        `);
        const order = resultRows(orderRows)[0];
        const orderId = order.id;

        // 8. Insert customerOrderLines (grouped by article)
        for (const line of lines) {
          const avgWeight = line.totalWeight / line.qty;
          await tx.execute(sql`
            INSERT INTO customer_order_lines (order_id, article_code, bale_name, qty, weight_per_bale, total_weight, price_per_bale, total_price)
            VALUES (${orderId}, ${line.articleCode}, ${line.baleName}, ${line.qty}, ${avgWeight.toFixed(3)}, ${line.totalWeight.toFixed(3)}, ${line.pricePerBale.toFixed(2)}, ${line.totalPrice.toFixed(2)})
          `);
        }

        // 9. Insert customerOrderBales (individual bale rows)
        for (const scan of scans) {
          // Need erpLocationId from factoryBales for the customerOrderBales.location_id column
          const baleRow = await tx.execute(
            sql`SELECT erp_location_id FROM factory_bales WHERE id = ${scan.bale_id} LIMIT 1`
          );
          const baleData = firstRow<{ erp_location_id: number | null }>(baleRow);
          const locationId = baleData?.erp_location_id;
          if (!locationId)
            throw new Error(`Bale ${scan.bale_reference} has no ERP location set — cannot create invoice line`);

          await tx.execute(sql`
            INSERT INTO customer_order_bales (order_id, bale_id, bale_reference, location_id, weight, article_code, bale_name, price_used, scanned_by)
            VALUES (${orderId}, ${scan.bale_id}, ${scan.bale_reference}, ${locationId}, ${scan.weight_kg}, ${scan.article_code}, ${scan.product_name}, ${scan.price_used}, ${scan.scanned_by})
          `);
        }

        // 10. Mark all scanned bales as SOLD
        const baleIds = scans.map((s) => s.bale_id);
        await tx.execute(sql`
          UPDATE factory_bales SET status = 'SOLD', updated_at = now()
          WHERE id = ANY(${baleIds}::int[])
        `);

        // 11. Post to customerBalances (one row = one invoice)
        await tx.execute(sql`
          INSERT INTO customer_balances (company_id, customer_id, transaction_date, transaction_type, reference_type, reference_id, debit_amount, credit_amount, balance, currency, description, created_at)
          VALUES (${companyId}, ${batch.customer_id}, ${orderDate}, 'SALE', 'INVOICE', ${orderId}, ${grandTotal.toFixed(2)}, '0', ${grandTotal.toFixed(2)}, ${batch.currency || "USD"}, ${"Invoice " + invoiceNumber}, now())
        `);

        // 12. Update batch: INVOICED + finalOrderId
        await tx.execute(sql`
          UPDATE customer_dispatch_batches
          SET status = 'INVOICED', final_order_id = ${orderId}, updated_at = now()
          WHERE id = ${batchId}
        `);

        // 13. Mark all rides COMPLETED
        await tx.execute(sql`
          UPDATE customer_dispatch_truck_rides
          SET status = 'COMPLETED', updated_at = now()
          WHERE batch_id = ${batchId} AND company_id = ${companyId}
        `);

        // 14. Update proforma status
        if (proforma && proformaLines.length > 0) {
          // Count total ever-invoiced bales per article across all finalized orders for this proforma
          const invoicedCountsRows = await tx.execute(sql`
            SELECT cob.article_code, COUNT(*) AS cnt
            FROM customer_order_bales cob
            JOIN customer_orders co ON co.id = cob.order_id
            WHERE co.proforma_id_used = ${proforma.id}
              AND co.status = 'FINALIZED'
              AND co.company_id = ${companyId}
            GROUP BY cob.article_code
          `);
          const invoicedCounts: Record<string, number> = {};
          for (const r of resultRows<{ article_code: string; cnt: string | null }>(invoicedCountsRows)) {
            invoicedCounts[r.article_code] = parseInt(r.cnt || "0");
          }

          const allFulfilled = proformaLines.every((pl) => {
            const invoiced = invoicedCounts[pl.article_code] || 0;
            return invoiced >= pl.quantity;
          });
          const anyFulfilled = proformaLines.some((pl) => {
            const invoiced = invoicedCounts[pl.article_code] || 0;
            return invoiced > 0;
          });

          let newProformaStatus = proforma.status;
          let newIsActive = proforma.is_active;
          if (allFulfilled) {
            newProformaStatus = "FULLY_INVOICED";
            newIsActive = false;
          } else if (anyFulfilled) {
            newProformaStatus = "PARTIALLY_DISPATCHED";
          }

          await tx.execute(sql`
            UPDATE customer_proformas
            SET status = ${newProformaStatus}, is_active = ${newIsActive}, updated_at = now()
            WHERE id = ${proforma.id}
          `);
        }

        return {
          orderId,
          invoiceNumber,
          grandTotal: grandTotal.toFixed(2),
          totalBales: totalQtyBales,
          totalLines: lines.length,
        };
      });

      res.status(201).json({ ok: true, ...result });
    } catch (err: unknown) {
      const msg = getErrorMessage(err) || "";
      const is400 =
        msg.includes("not found") ||
        msg.includes("already") ||
        msg.includes("cancelled") ||
        msg.includes("must be DISPATCHED") ||
        msg.includes("No scanned") ||
        msg.includes("LOADING status") ||
        msg.includes("FULLY_INVOICED") ||
        msg.includes("CANCELLED");
      res.status(is400 ? 400 : 500).json({ message: getErrorMessage(err) });
    }
  });
}
