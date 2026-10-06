/**
 * stockSummaryLocationRoutes: LocationMonthlyVoucher endpoints.
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
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import {
  inventory,
  containers,
  containerOffloads,
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

export function registerLocationMonthlyVoucherRoutes(app: Express) {
  // Location Stock Item Monthly Vouchers - Get detailed transactions for a specific month at a location
  app.get(
    "/api/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month",
    requireAuth,
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        const stockItemId = parseInt(req.params.stockItemId);
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

        const location = await storage.getLocationById(locationId);
        if (!location) {
          return res.status(404).json({ message: "Location not found" });
        }

        const monthStart = new Date(year, month - 1, 1);
        const monthEnd = new Date(year, month, 0); // Last day of month
        const monthStartStr = monthStart.toISOString().split("T")[0];
        const monthEndStr = monthEnd.toISOString().split("T")[0];

        // Use the same historical inventory reconstruction as the monthly summary.
        // This prevents current-month movements (for example Credit Note returns)
        // from being incorrectly absorbed into the Opening Balance row.
        const openingCutoff = new Date(`${monthStartStr}T00:00:00.000Z`);
        openingCutoff.setUTCDate(openingCutoff.getUTCDate() - 1);
        const openingHistory = await calculateHistoricalLocationInventory(
          locationId,
          companyId,
          openingCutoff.toISOString().slice(0, 10)
        );
        const openingHistoryRow = openingHistory.find((row) => row.stockItemId === stockItemId);

        // ============ GET CURRENT INVENTORY (to check for unexplained stock from imports) ============
        const [currentInventory] = await db
          .select({
            quantity: inventory.quantity,
            averageRate: inventory.averageRate,
            totalValue: inventory.totalValue,
          })
          .from(inventory)
          .where(and(eq(inventory.locationId, locationId), eq(inventory.stockItemId, stockItemId)));

        const currentQty = toMoney(currentInventory?.quantity);
        const currentRate = toMoney(currentInventory?.averageRate);
        // totalValue is the exact stored asset value; averageRate is rounded cost memory.
        const storedCurrentValue = toMoney(currentInventory?.totalValue);
        const currentValue = storedCurrentValue.isZero() ? currentQty.times(currentRate) : storedCurrentValue;

        // ============ CALCULATE MOVEMENTS AFTER THE SELECTED MONTH ============
        // To reconcile with inventory, we need to work backwards from current inventory
        let afterMonthNetQty: Decimal = new MoneyDecimal(0);
        let afterMonthNetValue: Decimal = new MoneyDecimal(0);

        // After-month Stock Transfers
        const afterTransfers = await db
          .select({
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
              sql`${vouchers.voucherDate}::date > ${monthEndStr}::date`,
              or(
                eq(stockTransferItems.sourceLocationId, locationId),
                eq(stockTransferVouchers.destinationLocationId, locationId)
              )
            )
          );

        for (const item of afterTransfers) {
          const qty = toMoney(item.quantity);
          const val = toMoney(item.totalAmount);
          if (item.sourceLocationId === locationId) {
            afterMonthNetQty = afterMonthNetQty.minus(qty);
            afterMonthNetValue = afterMonthNetValue.minus(val);
          }
          if (item.destinationLocationId === locationId) {
            afterMonthNetQty = afterMonthNetQty.plus(qty);
            afterMonthNetValue = afterMonthNetValue.plus(val);
          }
        }

        // After-month Stock Adjustments
        const afterAdjustments = await db
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
              eq(stockAdjustmentVouchers.locationId, locationId),
              sql`${vouchers.voucherDate}::date > ${monthEndStr}::date`
            )
          );

        for (const item of afterAdjustments) {
          afterMonthNetQty = afterMonthNetQty.plus(toMoney(item.quantity));
          afterMonthNetValue = afterMonthNetValue.plus(toMoney(item.totalAmount));
        }

        // After-month Sales
        const afterSales = await db
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
              eq(vouchers.locationId, locationId),
              sql`${vouchers.voucherDate}::date > ${monthEndStr}::date`
            )
          );

        for (const item of afterSales) {
          afterMonthNetQty = afterMonthNetQty.minus(toMoney(item.quantity));
          afterMonthNetValue = afterMonthNetValue.minus(toMoney(item.totalCost));
        }

        // After-month Container Offloads
        const afterOffloads = await db
          .select({
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
              sql`${containerOffloads.offloadedAt}::date > ${monthEndStr}::date`
            )
          );

        for (const item of afterOffloads) {
          const qty = toMoney(item.quantity);
          afterMonthNetQty = afterMonthNetQty.plus(qty);
          afterMonthNetValue = afterMonthNetValue
            .plus(toMoney(item.lineTotal))
            .plus(toMoney(item.additionalCostPerBale).times(qty));
        }

        // Calculate expected end-of-month closing from inventory (working backwards)
        const expectedClosingQty = currentQty.minus(afterMonthNetQty);
        const expectedClosingValue = currentValue.minus(afterMonthNetValue);
        const expectedClosingRate = expectedClosingQty.gt(0)
          ? expectedClosingValue.div(expectedClosingQty)
          : new MoneyDecimal(0);

        // ============ COLLECT CURRENT MONTH TRANSACTIONS AT THIS LOCATION ============
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
          isPOS?: boolean;
          posSellingRate?: number;
          posSellingValue?: number;
        }> = [];

        // 1. Stock Transfers involving this location
        const transferItems = await db
          .select({
            voucherDate: vouchers.voucherDate,
            voucherId: vouchers.id,
            quantity: stockTransferItems.quantity,
            rate: stockTransferItems.rate,
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
              sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`,
              or(
                eq(stockTransferItems.sourceLocationId, locationId),
                eq(stockTransferVouchers.destinationLocationId, locationId)
              )
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

          // Transfer OUT from this location
          if (item.sourceLocationId === locationId) {
            transactions.push({
              date: item.voucherDate,
              particulars: `To ${destName}`,
              vchType: "Stock Transfer",
              voucherId: item.voucherId,
              inwardQty: 0,
              inwardRate: 0,
              inwardValue: 0,
              outwardQty: qty,
              outwardRate: rate,
              outwardValue: val,
            });
          }

          // Transfer IN to this location
          if (item.destinationLocationId === locationId) {
            transactions.push({
              date: item.voucherDate,
              particulars: `From ${sourceName}`,
              vchType: "Stock Transfer",
              voucherId: item.voucherId,
              inwardQty: qty,
              inwardRate: rate,
              inwardValue: val,
              outwardQty: 0,
              outwardRate: 0,
              outwardValue: 0,
            });
          }
        }

        // 2. Stock Adjustments at this location
        const adjustmentItems = await db
          .select({
            voucherDate: vouchers.voucherDate,
            voucherId: vouchers.id,
            quantity: stockAdjustmentItems.quantity,
            rate: stockAdjustmentItems.rate,
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
          const value = Math.abs(rawValue);
          const isProduction = rawQty.gt(0);

          transactions.push({
            date: item.voucherDate,
            particulars: isProduction ? "Production" : "Consumption",
            vchType: isProduction ? "Production" : "Consumption",
            voucherId: item.voucherId,
            inwardQty: isProduction ? qty : 0,
            inwardRate: isProduction ? rate : 0,
            inwardValue: isProduction ? rawValue : 0,
            outwardQty: isProduction ? 0 : qty,
            outwardRate: isProduction ? 0 : rate,
            outwardValue: isProduction ? 0 : value,
          });
        }

        // 3. Sales at this location
        const salesData = await db
          .select({
            voucherDate: vouchers.voucherDate,
            voucherId: vouchers.id,
            quantity: salesItems.quantity,
            sellingPrice: salesItems.sellingPrice,
            totalSales: salesItems.totalSales,
            costPrice: salesItems.costPrice,
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
              sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`,
              sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
            )
          )
          .orderBy(vouchers.voucherDate);

        for (const item of salesData) {
          const qty = toMoney(item.quantity);
          const storedCostValue = toMoney(item.totalCost);
          const storedCostRate = toMoney(item.costPrice);
          const inventoryValue = storedCostValue.gt(0) ? storedCostValue : storedCostRate.times(qty);
          const inventoryRate = qty.gt(0) ? inventoryValue.div(qty) : storedCostRate;

          transactions.push({
            date: item.voucherDate,
            particulars: "Cash",
            vchType: "POS",
            voucherId: item.voucherId,
            inwardQty: 0,
            inwardRate: 0,
            inwardValue: 0,
            outwardQty: qty.toNumber(),
            outwardRate: inventoryRate.toNumber(),
            outwardValue: inventoryValue.toNumber(),
            isPOS: true,
            posSellingRate: toMoney(item.sellingPrice).toNumber(),
            posSellingValue: toMoney(item.totalSales).toNumber(),
          });
        }

        // 4. Credit / Debit Notes at this location
        const noteData = await db
          .select({
            voucherDate: vouchers.voucherDate,
            voucherId: vouchers.id,
            voucherNumber: vouchers.voucherNumber,
            noteType: vouchers.voucherType,
            quantity: creditNoteItems.quantity,
            inventoryCost: creditNoteItems.inventoryCost,
          })
          .from(creditNoteItems)
          .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
          .where(
            and(
              eq(creditNoteItems.stockItemId, stockItemId),
              eq(creditNoteItems.locationId, locationId),
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              sql`EXTRACT(YEAR FROM ${vouchers.voucherDate}) = ${year}`,
              sql`EXTRACT(MONTH FROM ${vouchers.voucherDate}) = ${month}`
            )
          )
          .orderBy(vouchers.voucherDate);

        for (const item of noteData) {
          const exactQty = toMoney(item.quantity).abs();
          const exactRate = MoneyDecimal.max(toMoney(item.inventoryCost), 0);
          const qty = exactQty.toNumber();
          const rate = exactRate.toNumber();
          const value = exactQty.times(exactRate).toNumber();
          const isCredit = item.noteType === "Credit Note";

          transactions.push({
            date: item.voucherDate,
            particulars: item.voucherNumber || item.noteType || "Credit/Debit Note",
            vchType: isCredit ? "Credit Note" : "Debit Note",
            voucherId: item.voucherId,
            inwardQty: isCredit ? qty : 0,
            inwardRate: isCredit ? rate : 0,
            inwardValue: isCredit ? value : 0,
            outwardQty: isCredit ? 0 : qty,
            outwardRate: isCredit ? 0 : rate,
            outwardValue: isCredit ? 0 : value,
          });
        }

        // 5. Container Offloads at this location (Inwards from PO imports)
        const offloadData = await db
          .select({
            offloadedAt: containerOffloads.offloadedAt,
            containerId: containerOffloads.containerId,
            containerCode: containers.containerNumber,
            poId: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            quantity: poLineItems.quantity,
            rate: poLineItems.rate,
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
              sql`EXTRACT(YEAR FROM ${containerOffloads.offloadedAt}) = ${year}`,
              sql`EXTRACT(MONTH FROM ${containerOffloads.offloadedAt}) = ${month}`
            )
          )
          .orderBy(containerOffloads.offloadedAt);

        for (const item of offloadData) {
          const qty = toMoney(item.quantity);
          const landedValue = toMoney(item.lineTotal).plus(toMoney(item.additionalCostPerBale).times(qty));
          // A zero quantity has no rate; NaN serialises as null, as the float division did.
          const landedRate = qty.isZero() ? Number.NaN : landedValue.div(qty).toNumber();

          const offloadDateStr =
            item.offloadedAt instanceof Date
              ? item.offloadedAt.toISOString().split("T")[0]
              : String(item.offloadedAt).split("T")[0];

          transactions.push({
            date: offloadDateStr,
            particulars: `Container: ${item.containerCode} / PO: ${item.poNumber}`,
            vchType: "PO Offload",
            voucherId: 0,
            poId: item.poId,
            inwardQty: qty.toNumber(),
            inwardRate: landedRate,
            inwardValue: landedValue.toNumber(),
            outwardQty: 0,
            outwardRate: 0,
            outwardValue: 0,
          });
        }

        // Sort transactions by date, with inward transactions before outward on same date
        transactions.sort((a, b) => {
          const dateCompare = new Date(a.date).getTime() - new Date(b.date).getTime();
          if (dateCompare !== 0) return dateCompare;
          // On same date, inward before outward (so opening stock shows first)
          if (a.inwardQty > 0 && b.outwardQty > 0) return -1;
          if (a.outwardQty > 0 && b.inwardQty > 0) return 1;
          return 0;
        });

        // Calculate in-month net movements from transactions
        const inMonthInwardQty = sumMoney(transactions.map((t) => t.inwardQty));
        const inMonthOutwardQty = sumMoney(transactions.map((t) => t.outwardQty));

        // Calculate what the opening balance SHOULD be based on:
        // expectedClosing = expectedOpening + inMonthInward - inMonthOutward
        // Therefore: expectedOpening = expectedClosing - inMonthInward + inMonthOutward
        const expectedOpeningQty = expectedClosingQty.minus(inMonthInwardQty).plus(inMonthOutwardQty);
        const expectedOpeningRate = expectedClosingRate; // Use the expected rate
        const expectedOpeningValue = expectedOpeningQty.times(expectedOpeningRate);

        // Use the historical snapshot when there is one, else the expected opening,
        // which reconciles with inventory.
        const historicalOpeningQty = openingHistoryRow ? toMoney(openingHistoryRow.quantity) : expectedOpeningQty;
        const historicalOpeningValue = openingHistoryRow ? toMoney(openingHistoryRow.totalValue) : expectedOpeningValue;
        const historicalOpeningStoredRate = openingHistoryRow
          ? toMoney(openingHistoryRow.averageRate)
          : expectedOpeningRate;

        let openingQty = historicalOpeningQty.toDecimalPlaces(3, MoneyDecimal.ROUND_HALF_CEIL);
        let openingValue = historicalOpeningValue;
        let openingRate =
          openingQty.gt(0) && openingValue.gt(0)
            ? openingValue.div(openingQty)
            : MoneyDecimal.max(historicalOpeningStoredRate, 0);

        // Handle edge cases: if opening is negative, something is wrong
        if (openingQty.lt(0)) {
          // Negative opening means more was sold than could have existed
          // This indicates data issues - clamp to zero for display
          openingQty = new MoneyDecimal(0);
          openingValue = new MoneyDecimal(0);
          openingRate = new MoneyDecimal(0);
        }

        // Calculate running balance - start with the full expected opening (includes imports)
        let runningQty = openingQty;
        let runningValue = openingValue;
        const opening = { qty: openingQty.toNumber(), rate: openingRate.toNumber(), value: openingValue.toNumber() };

        const transactionsWithBalance: Array<{
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
          closingQty: number;
          closingRate: number;
          closingValue: number;
          isOpeningBalance?: boolean;
          isPOS?: boolean;
          posSellingRate?: number;
          posSellingValue?: number;
        }> = [];

        // Add Opening Balance row if there's opening stock
        if (openingQty.gt(0) || openingValue.gt(0)) {
          transactionsWithBalance.push({
            date: monthStartStr,
            particulars: "Opening Balance",
            vchType: "",
            voucherId: 0,
            inwardQty: opening.qty,
            inwardRate: opening.rate,
            inwardValue: opening.value,
            outwardQty: 0,
            outwardRate: 0,
            outwardValue: 0,
            closingQty: opening.qty,
            closingRate: opening.rate,
            closingValue: opening.value,
            isOpeningBalance: true,
          });
        }

        // Calculate running balance for each transaction using weighted average cost
        for (const t of transactions) {
          const outwardQty = toMoney(t.outwardQty);
          const currentAvgRate = runningQty.gt(0) ? runningValue.div(runningQty) : new MoneyDecimal(0);
          runningQty = runningQty.plus(toMoney(t.inwardQty)).minus(outwardQty);
          const storedOutwardCost = outwardQty.gt(0)
            ? MoneyDecimal.max(toMoney(t.outwardValue), 0)
            : new MoneyDecimal(0);
          const actualOutwardCost = outwardQty.gt(0)
            ? storedOutwardCost.gt(0)
              ? storedOutwardCost
              : outwardQty.times(currentAvgRate)
            : new MoneyDecimal(0);
          runningValue = runningValue.plus(toMoney(t.inwardValue)).minus(actualOutwardCost);
          const avgClosingRate = runningQty.gt(0) ? runningValue.div(runningQty) : new MoneyDecimal(0);

          const displayOutwardRate = outwardQty.isZero() ? 0 : actualOutwardCost.div(outwardQty).toNumber();
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

        // Re-anchor the month close to the same historical inventory snapshot used
        // by the monthly summary so both views show identical quantity/value.
        const closingHistory = await calculateHistoricalLocationInventory(locationId, companyId, monthEndStr);
        const closingHistoryRow = closingHistory.find((row) => row.stockItemId === stockItemId);
        const finalClosingQty = (closingHistoryRow ? toMoney(closingHistoryRow.quantity) : expectedClosingQty)
          .toDecimalPlaces(3, MoneyDecimal.ROUND_HALF_CEIL)
          .toNumber();
        const exactClosingValue = closingHistoryRow ? toMoney(closingHistoryRow.totalValue) : expectedClosingValue;
        const closingStoredRate = closingHistoryRow ? toMoney(closingHistoryRow.averageRate) : expectedClosingRate;
        const finalClosingValue = exactClosingValue.toNumber();
        const finalClosingRate =
          finalClosingQty > 0 && exactClosingValue.gt(0)
            ? exactClosingValue.div(finalClosingQty).toNumber()
            : MoneyDecimal.max(closingStoredRate, 0).toNumber();

        // Update last transaction's closing to match expected closing
        if (transactionsWithBalance.length > 0) {
          const lastTx = transactionsWithBalance[transactionsWithBalance.length - 1];
          lastTx.closingQty = finalClosingQty;
          lastTx.closingRate = finalClosingRate;
          lastTx.closingValue = finalClosingValue;
        }

        const processedTransactions = transactionsWithBalance.filter((t) => !t.isOpeningBalance);
        const totals = {
          inwardQty: sumMoney(processedTransactions.map((t) => t.inwardQty)).toNumber(),
          inwardRate: 0,
          inwardValue: sumMoney(processedTransactions.map((t) => t.inwardValue)).toNumber(),
          outwardQty: sumMoney(processedTransactions.map((t) => t.outwardQty)).toNumber(),
          outwardRate: 0,
          outwardValue: sumMoney(processedTransactions.map((t) => t.outwardValue)).toNumber(),
          closingQty: finalClosingQty,
          closingRate: finalClosingRate,
          closingValue: finalClosingValue,
        };
        totals.inwardRate = totals.inwardQty > 0 ? totals.inwardValue / totals.inwardQty : 0;
        totals.outwardRate = totals.outwardQty > 0 ? totals.outwardValue / totals.outwardQty : 0;

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
          location,
          year,
          month,
          monthName: monthNames[month - 1],
          openingBalance: opening,
          transactions: transactionsWithBalance,
          totals,
        });
      } catch (error: unknown) {
        logger.error("Location stock item monthly vouchers error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
