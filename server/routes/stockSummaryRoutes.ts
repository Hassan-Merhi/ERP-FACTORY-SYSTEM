import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import {
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  containerOffloads,
  containerOffloadItems,
  purchaseOrders,
  poLineItems,
  vouchers,
  salesItems,
  creditNoteItems,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { registerStockSummaryLocationRoutes } from "./stock-summary-location";
import type Decimal from "decimal.js";
import { MoneyDecimal, sumMoney, toMoney } from "../lib/money";

const ZERO = new MoneyDecimal(0);

export function registerStockSummaryRoutes(app: Express) {
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

  // Stock Item Monthly Vouchers - Get detailed transactions for a specific month
  app.get("/api/stock-items/:id/vouchers/:year/:month", requireAuth, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      const year = parseInt(req.params.year);
      const month = parseInt(req.params.month);
      const companyId = req.session.currentCompanyId;

      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const stockItem = await storage.getStockItemById(stockItemId);
      if (!stockItem) {
        return res.status(404).json({ message: "Stock item not found" });
      }

      // Calculate the first day of the selected month for opening balance cutoff
      const monthStart = new Date(year, month - 1, 1);
      const monthStartStr = monthStart.toISOString().split("T")[0];

      // ============ CALCULATE OPENING BALANCE (all transactions BEFORE selected month) ============
      let openingQty: Decimal = ZERO;
      let openingValue: Decimal = ZERO;

      // Opening from PO Line Items
      const priorPOItems = await db
        .select({
          quantity: poLineItems.quantity,
          lineTotal: poLineItems.lineTotal,
        })
        .from(poLineItems)
        .innerJoin(purchaseOrders, eq(poLineItems.poId, purchaseOrders.id))
        .innerJoin(containers, eq(purchaseOrders.containerId, containers.id))
        .where(
          and(
            eq(poLineItems.stockItemId, stockItemId),
            eq(purchaseOrders.companyId, companyId),
            sql`${purchaseOrders.createdAt} < ${monthStartStr}::date`
          )
        );

      for (const item of priorPOItems) {
        openingQty = openingQty.plus(toMoney(item.quantity));
        openingValue = openingValue.plus(toMoney(item.lineTotal));
      }

      // Stock transfers before the month move stock between locations and net to
      // zero for the company-wide view, so they do not enter the opening balance.

      // Opening from Stock Adjustments (Production adds, Consumption subtracts)
      const priorAdjustments = await db
        .select({
          quantity: stockAdjustmentItems.quantity,
          totalAmount: stockAdjustmentItems.totalAmount,
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
            sql`${vouchers.voucherDate}::date < ${monthStartStr}::date`
          )
        );

      // totalAmount is already signed (positive for production, negative for consumption)
      // Just add the signed values directly
      for (const item of priorAdjustments) {
        openingQty = openingQty.plus(toMoney(item.quantity));
        openingValue = openingValue.plus(toMoney(item.totalAmount));
      }

      // Opening from Sales (reduces stock)
      const priorSales = await db
        .select({
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
            sql`${vouchers.voucherDate}::date < ${monthStartStr}::date`
          )
        );

      for (const item of priorSales) {
        openingQty = openingQty.minus(toMoney(item.quantity));
        openingValue = openingValue.minus(toMoney(item.totalCost));
      }

      const openingRate = openingQty.gt(0) ? openingValue.div(openingQty) : ZERO;
      const opening = { qty: openingQty.toNumber(), rate: openingRate.toNumber(), value: openingValue.toNumber() };

      // ============ COLLECT CURRENT MONTH TRANSACTIONS ============
      const transactions: Array<{
        date: string;
        particulars: string;
        vchType: string;
        voucherId: number;
        poId?: number;
        inwardQty: number;
        inwardRate: number;
        inwardValue: number;
        outwardQty: number;
        outwardRate: number;
        outwardValue: number;
        isOpeningBalance?: boolean;
        isPOS?: boolean;
        posSellingRate?: number;
        posSellingValue?: number;
      }> = [];

      // 1. PO Line Items (Inwards)
      const poItems = await db
        .select({
          date: purchaseOrders.createdAt,
          poId: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          containerNumber: containers.containerNumber,
          quantity: poLineItems.quantity,
          rate: poLineItems.rate,
          lineTotal: poLineItems.lineTotal,
        })
        .from(poLineItems)
        .innerJoin(purchaseOrders, eq(poLineItems.poId, purchaseOrders.id))
        .innerJoin(containers, eq(purchaseOrders.containerId, containers.id))
        .where(
          and(
            eq(poLineItems.stockItemId, stockItemId),
            eq(purchaseOrders.companyId, companyId),
            sql`EXTRACT(YEAR FROM ${purchaseOrders.createdAt}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${purchaseOrders.createdAt}) = ${month}`
          )
        )
        .orderBy(purchaseOrders.createdAt);

      for (const item of poItems) {
        transactions.push({
          date: item.date.toISOString().split("T")[0],
          particulars: item.containerNumber,
          vchType: "PURCHASE IMPORT",
          voucherId: 0,
          poId: item.poId,
          inwardQty: toMoney(item.quantity).toNumber(),
          inwardRate: toMoney(item.rate).toNumber(),
          inwardValue: toMoney(item.lineTotal).toNumber(),
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
        });
      }

      // 2. Stock Transfers
      const transferItems = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherNumber: vouchers.voucherNumber,
          voucherId: vouchers.id,
          quantity: stockTransferItems.quantity,
          rate: stockTransferItems.rate,
          totalAmount: stockTransferItems.totalAmount,
          sourceLocationId: stockTransferItems.sourceLocationId,
          destinationLocationId: stockTransferVouchers.destinationLocationId,
          optional: vouchers.optional,
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
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        )
        .orderBy(vouchers.voucherDate);

      // Get location names for transfers
      const locationIds = new Set<number>();
      for (const item of transferItems) {
        if (item.sourceLocationId) locationIds.add(item.sourceLocationId);
        if (item.destinationLocationId) locationIds.add(item.destinationLocationId);
      }

      const locationMap: Record<number, string> = {};
      for (const locId of Array.from(locationIds)) {
        const loc = await storage.getLocationById(locId);
        if (loc) locationMap[locId] = loc.name;
      }

      for (const item of transferItems) {
        const qty = toMoney(item.quantity).toNumber();
        const rate = toMoney(item.rate).toNumber();
        const val = toMoney(item.totalAmount).toNumber();
        const sourceName = item.sourceLocationId ? locationMap[item.sourceLocationId] || "Unknown" : "Unknown";
        const destName = locationMap[item.destinationLocationId] || "Unknown";

        // Add as Outward from source
        transactions.push({
          date: item.voucherDate,
          particulars: `To ${destName}`,
          vchType: `Stock Transfer - ${sourceName}`,
          voucherId: item.voucherId,
          inwardQty: 0,
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: qty,
          outwardRate: rate,
          outwardValue: val,
        });

        // Add as Inward to destination
        transactions.push({
          date: item.voucherDate,
          particulars: `From ${sourceName}`,
          vchType: `Stock Transfer - ${destName}`,
          voucherId: item.voucherId,
          inwardQty: qty,
          inwardRate: rate,
          inwardValue: val,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
        });
      }

      // 3. Stock Adjustments
      const adjustmentItems = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherNumber: vouchers.voucherNumber,
          voucherId: vouchers.id,
          quantity: stockAdjustmentItems.quantity,
          rate: stockAdjustmentItems.rate,
          totalAmount: stockAdjustmentItems.totalAmount,
          adjustmentType: stockAdjustmentVouchers.adjustmentType,
          locationId: stockAdjustmentVouchers.locationId,
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
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        )
        .orderBy(vouchers.voucherDate);

      for (const item of adjustmentItems) {
        const rawQty = toMoney(item.quantity);
        const rawValue = toMoney(item.totalAmount).toNumber();
        const qty = rawQty.abs().toNumber();
        const rate = toMoney(item.rate).toNumber();
        const value = Math.abs(rawValue); // Use absolute value for outward
        const locName =
          locationMap[item.locationId] || (await storage.getLocationById(item.locationId))?.name || "Unknown";
        const isProduction = rawQty.gt(0);

        transactions.push({
          date: item.voucherDate,
          particulars: locName,
          vchType: isProduction ? "Production" : "Consumption",
          voucherId: item.voucherId,
          inwardQty: isProduction ? qty : 0,
          inwardRate: isProduction ? rate : 0,
          inwardValue: isProduction ? rawValue : 0, // Use raw (positive) value for production
          outwardQty: isProduction ? 0 : qty,
          outwardRate: isProduction ? 0 : rate,
          outwardValue: isProduction ? 0 : value, // Use absolute value for consumption
        });
      }

      // 4. Sales (Outwards) - show each line item individually for this stock item
      const salesData = await db
        .select({
          voucherDate: vouchers.voucherDate,
          voucherNumber: vouchers.voucherNumber,
          voucherId: vouchers.id,
          locationId: vouchers.locationId,
          locationName: vouchers.locationName,
          quantity: salesItems.quantity,
          sellingPrice: salesItems.sellingPrice,
          totalSales: salesItems.totalSales,
          costPrice: salesItems.costPrice,
          totalCost: salesItems.totalCost,
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
            sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`,
            sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
          )
        )
        .orderBy(vouchers.voucherDate);

      // Each sales item for this stock item gets its own row (not grouped)
      // Store selling price separately, use cost for balance calculations
      for (const item of salesData) {
        const locName =
          item.locationName ||
          (item.locationId ? (await storage.getLocationById(item.locationId))?.name : null) ||
          "Cash";
        const qty = toMoney(item.quantity).toNumber();
        const sellingRate = toMoney(item.sellingPrice).toNumber();
        const totalSalesValue = toMoney(item.totalSales).toNumber();

        transactions.push({
          date: item.voucherDate,
          particulars: locName,
          vchType: `POS - ${locName}`,
          voucherId: item.voucherId,
          inwardQty: 0,
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: qty,
          outwardRate: 0, // Will be set to weighted avg cost in running balance loop
          outwardValue: 0, // Will be set to weighted avg cost in running balance loop
          isPOS: true,
          posSellingRate: sellingRate,
          posSellingValue: totalSalesValue,
        });
      }

      // Sort transactions by date
      transactions.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // START running balance from OPENING BALANCE (not zero!)
      let runningQty = openingQty;
      let runningValue = openingValue;

      // Build final transaction list with Opening Balance row first
      const transactionsWithBalance: Array<{
        date: string;
        particulars: string;
        vchType: string;
        voucherId: number;
        inwardQty: number;
        inwardRate: number;
        inwardValue: number;
        outwardQty: number;
        outwardRate: number;
        outwardValue: number;
        closingQty: number;
        closingRate: number;
        closingValue: number;
        isOpeningBalance?: boolean;
      }> = [];

      // Add Opening Balance row (only if there's a prior balance or prior transactions)
      // Per Tally's format: Opening Balance shows values in CLOSING columns only, not Inwards/Outwards
      if (!openingQty.isZero() || !openingValue.isZero()) {
        transactionsWithBalance.push({
          date: monthStartStr,
          particulars: "Opening Balance",
          vchType: "",
          voucherId: 0,
          inwardQty: 0, // Tally shows nothing in Inwards for opening
          inwardRate: 0,
          inwardValue: 0,
          outwardQty: 0,
          outwardRate: 0,
          outwardValue: 0,
          closingQty: opening.qty, // Only Closing columns show values
          closingRate: opening.rate,
          closingValue: opening.value,
          isOpeningBalance: true,
        });
      }

      // Calculate running balance for each transaction
      // Using weighted average cost method: outward items are valued at the current average rate for closing balance
      // POS transactions have SEPARATE posSellingRate/posSellingValue fields for display

      for (const t of transactions) {
        // Calculate current weighted average rate BEFORE processing this transaction
        const currentAvgRate = runningQty.gt(0) ? runningValue.div(runningQty) : ZERO;
        const outwardQty = toMoney(t.outwardQty);

        // Update running quantity
        runningQty = runningQty.plus(toMoney(t.inwardQty)).minus(outwardQty);

        // For value:
        // - Inward: add the actual transaction value (brings in inventory at transaction's rate)
        // - Outward: deduct at the CURRENT weighted average rate (not the stored transaction rate)
        // This ensures closing value = closingQty × closingRate (consistency)
        const actualOutwardCost = outwardQty.times(currentAvgRate);
        runningValue = runningValue.plus(toMoney(t.inwardValue)).minus(actualOutwardCost);

        // Weighted average rate after this transaction
        const avgClosingRate = runningQty.gt(0) ? runningValue.div(runningQty) : ZERO;

        // ALL outward transactions use weighted average cost for rate/value
        const displayOutwardRate = outwardQty.isZero() ? 0 : currentAvgRate.toNumber();
        const displayOutwardValue = outwardQty.isZero() ? 0 : actualOutwardCost.toNumber();

        transactionsWithBalance.push({
          ...t,
          outwardRate: displayOutwardRate,
          outwardValue: displayOutwardValue,
          closingQty: runningQty.toNumber(),
          closingRate: avgClosingRate.toNumber(),
          closingValue: runningValue.toNumber(),
        });
      }

      // Calculate totals from processed transactions (all now using cost basis)
      const processedTransactions = transactionsWithBalance.filter((t) => !t.isOpeningBalance);
      const inwardQtyTotal = sumMoney(processedTransactions.map((t) => t.inwardQty));
      const inwardValueTotal = sumMoney(processedTransactions.map((t) => t.inwardValue));
      const outwardQtyTotal = sumMoney(processedTransactions.map((t) => t.outwardQty));
      const outwardValueTotal = sumMoney(processedTransactions.map((t) => t.outwardValue));

      // Closing totals should be the FINAL running balance (same as last row)
      const totals = {
        inwardQty: inwardQtyTotal.toNumber(),
        inwardRate: inwardQtyTotal.gt(0) ? inwardValueTotal.div(inwardQtyTotal).toNumber() : 0,
        inwardValue: inwardValueTotal.toNumber(),
        outwardQty: outwardQtyTotal.toNumber(),
        outwardRate: outwardQtyTotal.gt(0) ? outwardValueTotal.div(outwardQtyTotal).toNumber() : 0,
        outwardValue: outwardValueTotal.toNumber(),
        closingQty: runningQty.toNumber(),
        closingRate: runningQty.gt(0) ? runningValue.div(runningQty).toNumber() : 0,
        closingValue: runningValue.toNumber(),
      };

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

      res.json({
        stockItem,
        year,
        month,
        monthName: monthNames[month - 1],
        openingBalance: opening,
        transactions: transactionsWithBalance,
        totals,
      });
    } catch (error: unknown) {
      logger.error("Stock item monthly vouchers error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerStockSummaryLocationRoutes(app);

  // Location Summary - Matrix view of all stock groups/items across selected locations
}
