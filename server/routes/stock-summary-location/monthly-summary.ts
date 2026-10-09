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
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
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
      // Quantities and values stay exact and become numbers only in the response.
      const ZERO = new MoneyDecimal(0);
      type Bucket = { inQty: Decimal; inVal: Decimal; outQty: Decimal; outVal: Decimal };
      const monthBuckets: Record<number, Bucket> = {};
      for (let m = 1; m <= 12; m++) {
        monthBuckets[m] = { inQty: ZERO, inVal: ZERO, outQty: ZERO, outVal: ZERO };
      }
      const addIn = (month: number, qty: Decimal, val: Decimal) => {
        monthBuckets[month].inQty = monthBuckets[month].inQty.plus(qty);
        monthBuckets[month].inVal = monthBuckets[month].inVal.plus(val);
      };
      const addOut = (month: number, qty: Decimal, val: Decimal) => {
        monthBuckets[month].outQty = monthBuckets[month].outQty.plus(qty);
        monthBuckets[month].outVal = monthBuckets[month].outVal.plus(val);
      };

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
        const qty = toMoney(row.quantity);
        const val = toMoney(row.totalAmount);

        // Transfer OUT from this location (source = this location)
        if (row.sourceLocationId === locationId) addOut(month, qty, val);
        // Transfer IN to this location (destination = this location)
        if (row.destinationLocationId === locationId) addIn(month, qty, val);
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
        const qty = toMoney(row.quantity).abs();
        const val = toMoney(row.totalAmount).abs();
        if (row.adjustmentType === "Production" || toMoney(row.quantity).greaterThan(0)) addIn(month, qty, val);
        else addOut(month, qty, val);
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
        addOut(month, toMoney(row.quantity), toMoney(row.totalCost));
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
        const qty = toMoney(row.quantity);
        const val = toMoney(row.inventoryCost).times(qty);
        if (row.noteType === "Credit Note") addIn(month, qty, val);
        else addOut(month, qty, val);
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
        addIn(month, toMoney(row.quantity), toMoney(row.totalValue));
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
        const qty = toMoney(row.quantity);
        const additionalCost = toMoney(row.additionalCostPerBale).times(qty);
        addIn(month, qty, toMoney(row.lineTotal).plus(additionalCost));
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
      const buckets = Object.values(monthBuckets);
      const totalYearInQty = sumMoney(buckets.map((b) => b.inQty));
      const totalYearInVal = sumMoney(buckets.map((b) => b.inVal));
      const totalYearOutQty = sumMoney(buckets.map((b) => b.outQty));
      const totalYearOutVal = sumMoney(buckets.map((b) => b.outVal));

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
      const derivedOpeningQty = toMoney(historicalRow?.quantity);
      const derivedOpeningVal = toMoney(historicalRow?.totalValue);

      // Calculate running closing balance starting from derived opening
      let runningQty = derivedOpeningQty;
      let runningVal = derivedOpeningVal;

      const rate = (val: Decimal, qty: Decimal) => (qty.greaterThan(0) ? val.dividedBy(qty).toNumber() : 0);
      // Three-decimal quantities, halves toward +infinity as Math.round rounded them.
      const qty3 = (qty: Decimal) => qty.toDecimalPlaces(3, MoneyDecimal.ROUND_HALF_CEIL);

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
        runningQty = runningQty.plus(bucket.inQty).minus(bucket.outQty);
        runningVal = runningVal.plus(bucket.inVal).minus(bucket.outVal);
        const closingQty = qty3(runningQty);
        const closingVal = runningVal;

        monthlyData.push({
          month: m,
          monthName: monthNames[m - 1],
          openingQty: qty3(openingQty).toNumber(),
          openingValue: openingVal.toNumber(),
          openingRate: rate(openingVal, openingQty),
          inwardQty: bucket.inQty.toNumber(),
          inwardValue: bucket.inVal.toNumber(),
          inwardRate: rate(bucket.inVal, bucket.inQty),
          outwardQty: bucket.outQty.toNumber(),
          outwardValue: bucket.outVal.toNumber(),
          outwardRate: rate(bucket.outVal, bucket.outQty),
          closingQty: closingQty.toNumber(),
          closingValue: closingVal.toNumber(),
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
        openingQty: qty3(derivedOpeningQty).toNumber(),
        openingValue: derivedOpeningVal.toNumber(),
        openingRate: rate(derivedOpeningVal, derivedOpeningQty),
        inwardQty: totalYearInQty.toNumber(),
        inwardValue: totalYearInVal.toNumber(),
        inwardRate: rate(totalYearInVal, totalYearInQty),
        outwardQty: totalYearOutQty.toNumber(),
        outwardValue: totalYearOutVal.toNumber(),
        outwardRate: rate(totalYearOutVal, totalYearOutQty),
        closingQty: year === currentYear ? Math.round(actualQty * 1000) / 1000 : qty3(runningQty).toNumber(),
        closingValue: year === currentYear ? actualValue : runningVal.toNumber(),
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
