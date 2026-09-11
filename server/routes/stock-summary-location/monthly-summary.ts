/**
 * stockSummaryLocationRoutes: LocationMonthlySummary endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { eq, and, or, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import {
  buildInventoryValuationReconciliation,
  inventorySnapshotFromStoredValues,
} from "../../services/inventory/inventoryValuationSnapshot";
import { calculateHistoricalLocationInventory } from "../_helpers";
import {
  inventory,
  containers,
  containerOffloads,
  containerOffloadItems,
  purchaseOrders,
  poLineItems,
  vouchers,
  salesItems,
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  creditNoteItems,
} from "@shared/schema";

export function registerLocationMonthlySummaryRoutes(app: Express) {
  // Location Stock Item Monthly Summary - Get aggregated monthly data for a stock item at a specific location
  app.get("/api/locations/:locationId/stock-items/:stockItemId/monthly-summary", requireAuth, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      const stockItemId = parseInt(req.params.stockItemId);
      const year =
        parseInt(req.query.year as string) ||
        (req.query.startDate ? new Date(req.query.startDate as string).getFullYear() : new Date().getFullYear());
      const companyId = req.session.currentCompanyId;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get the stock item and location info
      const stockItem = await storage.getStockItemById(stockItemId);
      if (!stockItem) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location) {
        return res.status(404).json({ message: "Location not found" });
      }

      const monthNames = [
        "January",
        "February",
        "March",
        "April",
        "May",
        "June",
        "July",
        "August",
        "September",
        "October",
        "November",
        "December",
      ];

      // Initialize monthly buckets
      const monthBuckets: Record<number, { inQty: number; inVal: number; outQty: number; outVal: number }> = {};
      for (let m = 1; m <= 12; m++) {
        monthBuckets[m] = { inQty: 0, inVal: 0, outQty: 0, outVal: 0 };
      }

      // 1. Stock Transfers - In and Out based on source/destination matching this location
      const stockTransfers = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: stockTransferItems.quantity,
          totalAmount: stockTransferItems.totalAmount,
          sourceLocationId: stockTransferItems.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
        })
        .from(stockTransferItems)
        .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
        .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
        .where(
          and(
            eq(stockTransferItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`,
            or(
              eq(stockTransferItems.sourceLocationId, locationId),
              eq(stockTransferVouchers.destinationLocationId, locationId)
            )
          )
        );

      for (const row of stockTransfers) {
        const month = Number(row.month);
        const qty = parseFloat(row.quantity);
        const val = parseFloat(row.totalAmount);

        // Transfer OUT from this location (source = this location)
        if (row.sourceLocationId === locationId) {
          monthBuckets[month].outQty += qty;
          monthBuckets[month].outVal += val;
        }
        // Transfer IN to this location (destination = this location)
        if (row.destinationLocationId === locationId) {
          monthBuckets[month].inQty += qty;
          monthBuckets[month].inVal += val;
        }
      }

      // 2. Stock Adjustments at this location
      const stockAdjustments = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: stockAdjustmentItems.quantity,
          totalAmount: stockAdjustmentItems.totalAmount,
          adjustmentType: stockAdjustmentVouchers.adjustmentType,
        })
        .from(stockAdjustmentItems)
        .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
        .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
        .where(
          and(
            eq(stockAdjustmentItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            eq(stockAdjustmentVouchers.locationId, locationId),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      for (const row of stockAdjustments) {
        const month = Number(row.month);
        const qty = Math.abs(parseFloat(row.quantity));
        const val = Math.abs(parseFloat(row.totalAmount));
        if (row.adjustmentType === "Production" || parseFloat(row.quantity) > 0) {
          monthBuckets[month].inQty += qty;
          monthBuckets[month].inVal += val;
        } else {
          monthBuckets[month].outQty += qty;
          monthBuckets[month].outVal += val;
        }
      }

      // 3. Sales at this location (Outwards) — use totalCost (cost price) for inventory valuation
      const salesData = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: salesItems.quantity,
          totalCost: salesItems.totalCost,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(
          and(
            eq(salesItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            eq(vouchers.locationId, locationId),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      for (const row of salesData) {
        const month = Number(row.month);
        monthBuckets[month].outQty += parseFloat(row.quantity);
        monthBuckets[month].outVal += parseFloat(row.totalCost || "0");
      }

      // 4. Credit / Debit Note Items at this location
      // Credit Notes restore stock (INWARD), Debit Notes reduce stock (OUTWARD)
      const creditDebitNotes = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: creditNoteItems.quantity,
          inventoryCost: creditNoteItems.inventoryCost,
          noteType: vouchers.voucherType,
        })
        .from(creditNoteItems)
        .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
        .where(
          and(
            eq(creditNoteItems.stockItemId, stockItemId),
            eq(creditNoteItems.locationId, locationId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      for (const row of creditDebitNotes) {
        const month = Number(row.month);
        const qty = parseFloat(row.quantity);
        const val = parseFloat(row.inventoryCost || "0") * qty;
        if (row.noteType === "Credit Note") {
          monthBuckets[month].inQty += qty;
          monthBuckets[month].inVal += val;
        } else {
          monthBuckets[month].outQty += qty;
          monthBuckets[month].outVal += val;
        }
      }

      // 5. Container Offloads at this location (Inwards - from PO imports)
      // Primary: use containerOffloadItems.totalValue — the exact dollar amount written to inventory.
      // This avoids the discrepancy between poLineItems.lineTotal + additionalCostPerBale and the
      // actual landed cost (which also includes PO freight via container.chargesTotal).
      const modernOffloadData = await db
        .select({
          offloadId: containerOffloads.id,
          month: sql<number>`EXTRACT(MONTH FROM ${containerOffloads.offloadedAt})`,
          quantity: containerOffloadItems.quantity,
          totalValue: containerOffloadItems.totalValue,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .innerJoin(containerOffloadItems, eq(containerOffloadItems.offloadId, containerOffloads.id))
        .where(
          and(
            eq(containerOffloadItems.stockItemId, stockItemId),
            eq(containers.companyId, companyId),
            eq(containerOffloads.locationId, locationId),
            sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`
          )
        );

      // Track which offload IDs were handled by the modern method to avoid double-counting
      const modernOffloadIds = new Set(modernOffloadData.map((r) => r.offloadId));

      for (const row of modernOffloadData) {
        const month = Number(row.month);
        monthBuckets[month].inQty += parseFloat(row.quantity);
        monthBuckets[month].inVal += parseFloat(row.totalValue);
      }

      // Legacy fallback: for older offloads without containerOffloadItems records
      const legacyOffloadData = await db
        .select({
          offloadId: containerOffloads.id,
          month: sql<number>`EXTRACT(MONTH FROM ${containerOffloads.offloadedAt})`,
          quantity: poLineItems.quantity,
          lineTotal: poLineItems.lineTotal,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .innerJoin(purchaseOrders, eq(purchaseOrders.containerId, containers.id))
        .innerJoin(poLineItems, eq(poLineItems.poId, purchaseOrders.id))
        .where(
          and(
            eq(poLineItems.stockItemId, stockItemId),
            eq(containers.companyId, companyId),
            eq(containerOffloads.locationId, locationId),
            sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`
          )
        );

      for (const row of legacyOffloadData) {
        // Skip offloads already handled by the modern containerOffloadItems method
        if (modernOffloadIds.has(row.offloadId)) continue;
        const month = Number(row.month);
        const qty = parseFloat(row.quantity);
        const baseValue = parseFloat(row.lineTotal);
        const additionalCost = parseFloat(row.additionalCostPerBale || "0") * qty;
        monthBuckets[month].inQty += qty;
        monthBuckets[month].inVal += baseValue + additionalCost;
      }

      // Live inventory is the current snapshot source of truth. Use stored
      // total_value as the authoritative asset amount; average_rate is rounded
      // cost memory and must never be multiplied back into a replacement value.
      const currentInventoryResult = await db
        .select({
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .where(
          and(
            eq(inventory.companyId, companyId),
            eq(inventory.stockItemId, stockItemId),
            eq(inventory.locationId, locationId)
          )
        )
        .limit(1);

      const liveInventory = currentInventoryResult[0]
        ? inventorySnapshotFromStoredValues(
            currentInventoryResult[0].quantity,
            currentInventoryResult[0].totalValue,
            currentInventoryResult[0].averageRate
          )
        : inventorySnapshotFromStoredValues(0, 0, 0);
      const actualQty = liveInventory.quantity;
      const actualValue = liveInventory.totalValue;
      const actualRate = liveInventory.rate;

      // Calculate total movements for the year from vouchers
      const totalYearInQty = Object.values(monthBuckets).reduce((s, b) => s + b.inQty, 0);
      const totalYearInVal = Object.values(monthBuckets).reduce((s, b) => s + b.inVal, 0);
      const totalYearOutQty = Object.values(monthBuckets).reduce((s, b) => s + b.outQty, 0);
      const totalYearOutVal = Object.values(monthBuckets).reduce((s, b) => s + b.outVal, 0);
      const _totalYearNetQty = totalYearInQty - totalYearOutQty;
      const _totalYearNetVal = totalYearInVal - totalYearOutVal;

      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();

      // Derive the opening balance for Jan 1 of `year` by reconstructing the historical
      // balance backward from current live inventory (same source-of-truth approach used
      // by Location Inventory "as of" reports), rather than either (a) subtracting this
      // route's own voucher-derived net movements from actualQty — which silently drifts
      // whenever a transaction type is captured inconsistently between the two — or
      // (b) hardcoding 0 for past years, which is simply wrong whenever the item had any
      // stock at that point.
      const historicalAsOfPriorYearEnd = await calculateHistoricalLocationInventory(
        locationId,
        companyId,
        `${year - 1}-12-31`
      );
      const historicalRow = historicalAsOfPriorYearEnd.find((r) => r.stockItemId === stockItemId);
      const derivedOpeningQty = historicalRow ? parseFloat(historicalRow.quantity) || 0 : 0;
      const derivedOpeningVal = historicalRow ? parseFloat(historicalRow.totalValue) || 0 : 0;

      // Calculate running closing balance starting from derived opening
      let runningQty = derivedOpeningQty;
      let runningVal = derivedOpeningVal;

      const rate = (val: number, qty: number) => (qty > 0 ? val / qty : 0);

      const monthlyData: Array<{
        month: number;
        monthName: string;
        openingQty: number;
        openingValue: number;
        openingRate: number;
        inwardQty: number;
        inwardValue: number;
        inwardRate: number;
        outwardQty: number;
        outwardValue: number;
        outwardRate: number;
        closingQty: number;
        closingValue: number;
        closingRate: number;
      }> = [];

      for (let m = 1; m <= 12; m++) {
        const bucket = monthBuckets[m];
        const openingQty = runningQty;
        const openingVal = runningVal;
        runningQty += bucket.inQty - bucket.outQty;
        runningVal += bucket.inVal - bucket.outVal;
        const closingQty = Math.round(runningQty * 1000) / 1000;
        const closingVal = runningVal;

        monthlyData.push({
          month: m,
          monthName: monthNames[m - 1],
          openingQty: Math.round(openingQty * 1000) / 1000,
          openingValue: openingVal,
          openingRate: rate(openingVal, openingQty),
          inwardQty: bucket.inQty,
          inwardValue: bucket.inVal,
          inwardRate: rate(bucket.inVal, bucket.inQty),
          outwardQty: bucket.outQty,
          outwardValue: bucket.outVal,
          outwardRate: rate(bucket.outVal, bucket.outQty),
          closingQty,
          closingValue: closingVal,
          closingRate: rate(closingVal, closingQty),
        });
      }

      // Never mutate a calendar month with today's inventory. For a current-year
      // report, compare the derived current-month closing with the live snapshot
      // and expose any drift explicitly so it can be audited without corrupting
      // future months such as December.
      const reconciliation =
        year === currentYear
          ? (() => {
              const asOfMonth = currentDate.getMonth() + 1;
              const derivedCurrentMonth = monthlyData[asOfMonth - 1];
              return buildInventoryValuationReconciliation(
                asOfMonth,
                liveInventory,
                inventorySnapshotFromStoredValues(
                  derivedCurrentMonth.closingQty,
                  derivedCurrentMonth.closingValue,
                  derivedCurrentMonth.closingRate
                )
              );
            })()
          : null;

      const grandTotal = {
        openingQty: Math.round(derivedOpeningQty * 1000) / 1000,
        openingValue: derivedOpeningVal,
        openingRate: rate(derivedOpeningVal, derivedOpeningQty),
        inwardQty: totalYearInQty,
        inwardValue: totalYearInVal,
        inwardRate: rate(totalYearInVal, totalYearInQty),
        outwardQty: totalYearOutQty,
        outwardValue: totalYearOutVal,
        outwardRate: rate(totalYearOutVal, totalYearOutQty),
        closingQty: year === currentYear ? Math.round(actualQty * 1000) / 1000 : Math.round(runningQty * 1000) / 1000,
        closingValue: year === currentYear ? actualValue : runningVal,
        closingRate: year === currentYear ? actualRate : rate(runningVal, runningQty),
      };

      res.json({
        stockItem,
        location,
        year,
        monthlyData,
        grandTotal,
        reconciliation,
      });
    } catch (error: unknown) {
      logger.error("Location stock item monthly summary error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
