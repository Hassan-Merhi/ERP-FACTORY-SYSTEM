// Extracted from ./stockSummaryRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import {
  containerOffloadItems,
  containerOffloads,
  containers,
  creditNoteItems,
  poLineItems,
  purchaseOrders,
  salesItems,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  vouchers,
} from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";

export const ZERO = new MoneyDecimal(0);

export function registerStockSummaryRoutesStep1(app: Express) {
  app.get("/api/stock-items/:id/monthly-summary", requireAuth, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      const year =
        parseInt(req.query.year as string) ||
        (req.query.startDate ? new Date(req.query.startDate as string).getFullYear() : new Date().getFullYear());
      const companyId = req.session.currentCompanyId;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get the stock item info
      const stockItem = await storage.getStockItemById(stockItemId);
      if (!stockItem) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      // Initialize monthly data
      const monthlyData: Array<{
        month: number;
        monthName: string;
        inwardQty: number;
        inwardValue: number;
        outwardQty: number;
        outwardValue: number;
        closingQty: number;
        closingValue: number;
      }> = [];

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

      // Query all relevant transactions for this stock item in the year
      // 1. Container Offloads (Inwards) — use containerOffloadItems.totalValue (exact inventory value).
      // Primary: containerOffloadItems stores the exact dollar amount that was written to inventory,
      // including PO freight via container.chargesTotal which additionalCostPerBale alone misses.
      const modernPoInwards = await db
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
            sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`
          )
        );

      // Legacy fallback: older offloads without containerOffloadItems records
      const modernPoOffloadIds = new Set(modernPoInwards.map((r) => r.offloadId));
      const legacyPoInwards = await db
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
            sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`
          )
        );

      // 2. Credit / Debit Note Items (company-wide, all locations)
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
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      // 3. Stock Adjustments (Production = In, Consumption = Out)
      const stockAdjustments = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: stockAdjustmentItems.quantity,
          rate: stockAdjustmentItems.rate,
          totalAmount: stockAdjustmentItems.totalAmount,
          adjustmentType: stockAdjustmentVouchers.adjustmentType,
          optional: vouchers.optional,
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
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      // 4. Sales (Outwards) — use totalSales (selling price) not totalCost (cost price)
      const salesData = await db
        .select({
          month: sql<number>`EXTRACT(MONTH FROM ${vouchers.voucherDate})`,
          quantity: salesItems.quantity,
          totalSales: salesItems.totalSales,
          optional: vouchers.optional,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(
          and(
            eq(salesItems.stockItemId, stockItemId),
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            eq(vouchers.optional, false),
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`
          )
        );

      // Initialize monthly buckets
      const monthBuckets: Record<number, { inQty: Decimal; inVal: Decimal; outQty: Decimal; outVal: Decimal }> = {};
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

      // Process Container Offload Inwards — modern method (exact inventory values)
      for (const row of modernPoInwards) {
        const month = Number(row.month);
        addIn(month, toMoney(row.quantity), toMoney(row.totalValue));
      }

      // Legacy fallback — older offloads without containerOffloadItems records
      for (const row of legacyPoInwards) {
        if (modernPoOffloadIds.has(row.offloadId)) continue;
        const month = Number(row.month);
        const qty = toMoney(row.quantity);
        addIn(month, qty, toMoney(row.lineTotal).plus(toMoney(row.additionalCostPerBale).times(qty)));
      }

      // Process Credit / Debit Notes
      // Credit Notes = customer returned goods = INWARD; Debit Notes = stock reduced = OUTWARD
      for (const row of creditDebitNotes) {
        const month = Number(row.month);
        const qty = toMoney(row.quantity);
        const val = toMoney(row.inventoryCost).times(qty);
        if (row.noteType === "Credit Note") addIn(month, qty, val);
        else addOut(month, qty, val);
      }

      // Process Stock Adjustments
      for (const row of stockAdjustments) {
        const month = Number(row.month);
        const signedQty = toMoney(row.quantity);
        const qty = signedQty.abs();
        const val = toMoney(row.totalAmount);
        if (row.adjustmentType === "Production" || signedQty.gt(0)) addIn(month, qty, val);
        else addOut(month, qty, val);
      }

      // Process Sales (always outward) — value = selling revenue
      for (const row of salesData) {
        const month = Number(row.month);
        addOut(month, toMoney(row.quantity), toMoney(row.totalSales));
      }

      // Calculate running closing balance
      let runningQty: Decimal = ZERO;
      let runningVal: Decimal = ZERO;

      // Get opening balance from inventory or assume 0 for start of year
      // For simplicity, we'll calculate it as prior year closing balance would be opening

      for (let m = 1; m <= 12; m++) {
        const bucket = monthBuckets[m];
        runningQty = runningQty.plus(bucket.inQty).minus(bucket.outQty);
        runningVal = runningVal.plus(bucket.inVal).minus(bucket.outVal);

        monthlyData.push({
          month: m,
          monthName: monthNames[m - 1],
          inwardQty: bucket.inQty.toNumber(),
          inwardValue: bucket.inVal.toNumber(),
          outwardQty: bucket.outQty.toNumber(),
          outwardValue: bucket.outVal.toNumber(),
          closingQty: runningQty.toNumber(),
          closingValue: runningVal.toNumber(),
        });
      }

      // Calculate grand totals
      const grandTotal = {
        inwardQty: sumMoney(Object.values(monthBuckets).map((b) => b.inQty)).toNumber(),
        inwardValue: sumMoney(Object.values(monthBuckets).map((b) => b.inVal)).toNumber(),
        outwardQty: sumMoney(Object.values(monthBuckets).map((b) => b.outQty)).toNumber(),
        outwardValue: sumMoney(Object.values(monthBuckets).map((b) => b.outVal)).toNumber(),
        closingQty: runningQty.toNumber(),
        closingValue: runningVal.toNumber(),
      };

      res.json({
        stockItem,
        year,
        monthlyData,
        grandTotal,
      });
    } catch (error: unknown) {
      logger.error("Stock item monthly summary error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
  return {};
}
