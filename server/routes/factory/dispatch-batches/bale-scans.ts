/**
 * factoryDispatchBatchRoutes: DispatchBaleScan endpoints.
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
  customerDispatchBaleScans,
  customerProformaLines,
} from "@shared/schema";

import { getCompanyId, getUsername, isAdmin } from "./_helpers";
import { firstRow, resultRows } from "../../../lib/queryResult";
import { lineAmount } from "../../../lib/money";

export function registerDispatchBaleScanRoutes(app: Express) {
  // ── POST /api/factory/dispatch-truck-rides/:id/scan-bale ──────────────────
  // Scan a bale barcode into a truck ride
  app.post("/api/factory/dispatch-truck-rides/:id/scan-bale", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const rideId = parseId(req.params.id);
      if (rideId === null) return res.status(400).json({ message: "Invalid id" });

      const { barcode } = req.body;
      if (!barcode) return res.status(400).json({ message: "barcode is required" });

      const result = await db.transaction(async (tx) => {
        // 1. Validate ride
        const [ride] = await tx
          .select()
          .from(customerDispatchTruckRides)
          .where(and(eq(customerDispatchTruckRides.id, rideId), eq(customerDispatchTruckRides.companyId, companyId)));
        if (!ride) throw new Error("Truck ride not found");
        if (ride.status === "DISPATCHED")
          throw new Error("This truck ride is already dispatched. Reopen it before scanning.");
        if (ride.status === "CANCELLED") throw new Error("This truck ride is cancelled");

        // 2. Load batch (needed for proforma check)
        const [batch] = await tx
          .select()
          .from(customerDispatchBatches)
          .where(and(eq(customerDispatchBatches.id, ride.batchId), eq(customerDispatchBatches.companyId, companyId)));
        if (!batch) throw new Error("Dispatch batch not found");
        if (batch.status === "INVOICED") throw new Error("Batch already invoiced");
        if (batch.status === "CANCELLED") throw new Error("Batch is cancelled");

        // 3. Find bale by reference number
        const baleRows = await tx.execute(sql`
          SELECT id, reference_number AS "referenceNumber", article_code AS "articleCode",
                 product_name AS "productName", weight_kg AS "weightKg",
                 erp_location_id AS "erpLocationId", status
          FROM factory_bales
          WHERE reference_number = ${barcode.trim()} AND company_id = ${companyId}
          LIMIT 1
        `);
        const bale = firstRow<{
          id: number;
          referenceNumber: string;
          articleCode: string | null;
          productName: string | null;
          weightKg: string | null;
          erpLocationId: number | null;
          status: string | null;
        }>(baleRows);
        if (!bale) throw new Error(`Bale "${barcode}" not found`);

        // 4. Bale must be IN_STOCK
        if (bale.status !== "IN_STOCK")
          throw new Error(`Bale ${barcode} is not available — current status: ${bale.status}`);

        // 5. Cross-batch duplicate check (partial unique index handles DB level too)
        const dupCheck = await tx.execute(sql`
          SELECT s.id, b.batch_number AS "batchNumber"
          FROM customer_dispatch_bale_scans s
          JOIN customer_dispatch_batches b ON b.id = s.batch_id
          WHERE s.company_id = ${companyId} AND s.bale_id = ${bale.id} AND s.removed_at IS NULL
          LIMIT 1
        `);
        const dupRow = resultRows(dupCheck)[0];
        if (dupRow) throw new Error(`Bale ${barcode} is already scanned in dispatch batch ${dupRow.batchNumber}`);

        // 6. Cross-order duplicate check (legacy loading system)
        const orderDupCheck = await tx.execute(sql`
          SELECT cob.order_id FROM customer_order_bales cob
          JOIN customer_orders co ON co.id = cob.order_id
          WHERE cob.bale_id = ${bale.id} AND co.status != 'CANCELLED'
          LIMIT 1
        `);
        const orderDupRow = resultRows(orderDupCheck)[0];
        if (orderDupRow) throw new Error(`Bale ${barcode} is already loaded on invoice order #${orderDupRow.order_id}`);

        // 7. Proforma article check — hard block if batch is linked to a proforma
        let priceUsed = "0";
        let overageWarning = false;
        let proformaQtyForArticle = 0;
        let scannedQtyForArticle = 0;

        if (batch.proformaId) {
          const proformaLines = await tx
            .select()
            .from(customerProformaLines)
            .where(eq(customerProformaLines.proformaId, batch.proformaId));

          const matchingLine = proformaLines.find(
            (l: { articleCode: null | string }) => l.articleCode === bale.articleCode
          );
          if (!matchingLine) {
            throw new Error(
              `Bale ${barcode} has article code "${bale.articleCode}" which is not in the linked proforma. Scan blocked.`
            );
          }

          priceUsed = String(matchingLine.pricePerBale);
          proformaQtyForArticle = matchingLine.quantity;

          // Check scanned quantity for this article so far in this batch
          const qtyRows = await tx.execute(sql`
            SELECT COUNT(*) AS cnt FROM customer_dispatch_bale_scans
            WHERE batch_id = ${batch.id} AND company_id = ${companyId}
              AND article_code = ${bale.articleCode} AND removed_at IS NULL
          `);
          scannedQtyForArticle = parseInt(firstRow<{ cnt: string | null }>(qtyRows)?.cnt || "0");
          if (scannedQtyForArticle >= proformaQtyForArticle) {
            overageWarning = true;
          }
        }

        // 8. Calculate amount (priceMode is on the batch, not the bale)
        const amount = batch.priceMode === "PER_KG" ? lineAmount(priceUsed, bale.weightKg).toFixed(2) : priceUsed;

        // 9. Reserve bale
        await tx.execute(sql`
          UPDATE factory_bales SET status = 'RESERVED_FOR_DISPATCH', updated_at = now()
          WHERE id = ${bale.id}
        `);

        // 10. Insert scan record
        const [scan] = await tx
          .insert(customerDispatchBaleScans)
          .values({
            companyId,
            batchId: batch.id,
            truckRideId: rideId,
            baleId: bale.id,
            baleReference: bale.referenceNumber,
            articleCode: bale.articleCode || null,
            productName: bale.productName || null,
            weightKg: String(bale.weightKg || "0"),
            priceUsed,
            amount: String(amount),
            scannedBy: getUsername(req),
            scannedAt: new Date(),
          })
          .returning();

        // 11. Set ride to LOADING if it was DRAFT, stamp loadedAt
        if (ride.status === "DRAFT") {
          await tx
            .update(customerDispatchTruckRides)
            .set({ status: "LOADING", loadedAt: new Date(), updatedAt: new Date() })
            .where(eq(customerDispatchTruckRides.id, rideId));
        }

        return {
          scan,
          bale: {
            id: bale.id,
            referenceNumber: bale.referenceNumber,
            articleCode: bale.articleCode,
            productName: bale.productName,
            weightKg: bale.weightKg,
          },
          overageWarning,
          proformaQtyForArticle,
          scannedQtyForArticle: scannedQtyForArticle + 1,
          message: overageWarning
            ? `Bale scanned. WARNING: ${bale.articleCode} now exceeds proforma quantity (${proformaQtyForArticle}).`
            : "Bale scanned successfully.",
        };
      });

      res.status(201).json(result);
    } catch (err: unknown) {
      // Distinguish validation errors (400) from DB/system errors (500)
      const msg = getErrorMessage(err) || "";
      const is400 =
        msg.includes("not found") ||
        msg.includes("not available") ||
        msg.includes("already") ||
        msg.includes("not in the linked") ||
        msg.includes("cancelled") ||
        msg.includes("dispatched") ||
        msg.includes("invoiced");
      res.status(is400 ? 400 : 500).json({ message: getErrorMessage(err) });
    }
  });

  // ── DELETE /api/factory/dispatch-bale-scans/:id ───────────────────────────
  // Remove a bale scan (soft delete — marks removedAt, returns bale to IN_STOCK)
  app.delete("/api/factory/dispatch-bale-scans/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = getCompanyId(req);
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const scanId = parseId(req.params.id);
      if (scanId === null) return res.status(400).json({ message: "Invalid id" });

      const { reason } = req.body;

      await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        const [scan] = await tx
          .select()
          .from(customerDispatchBaleScans)
          .where(and(eq(customerDispatchBaleScans.id, scanId), eq(customerDispatchBaleScans.companyId, companyId)));
        if (!scan) throw new Error("Scan not found");
        if (scan.removedAt) throw new Error("Scan already removed");

        // Check if ride is dispatched — if so, only admin can remove
        const [ride] = await tx
          .select()
          .from(customerDispatchTruckRides)
          .where(eq(customerDispatchTruckRides.id, scan.truckRideId));
        if (ride?.status === "DISPATCHED") {
          const admin = await isAdmin(req, companyId);
          if (!admin) throw new Error("Only admins can remove bales from a dispatched ride. Reopen the ride first.");
        }

        // Check batch not invoiced
        const [batch] = await tx
          .select()
          .from(customerDispatchBatches)
          .where(eq(customerDispatchBatches.id, scan.batchId));
        if (batch?.status === "INVOICED") throw new Error("Cannot remove bales from an invoiced batch");

        // Soft-delete the scan
        await tx
          .update(customerDispatchBaleScans)
          .set({ removedAt: new Date(), removalReason: reason || null })
          .where(eq(customerDispatchBaleScans.id, scanId));

        // Return bale to IN_STOCK
        await tx.execute(sql`
          UPDATE factory_bales SET status = 'IN_STOCK', updated_at = now()
          WHERE id = ${scan.baleId} AND status = 'RESERVED_FOR_DISPATCH'
        `);
      });

      res.json({ ok: true });
    } catch (err: unknown) {
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });
}
