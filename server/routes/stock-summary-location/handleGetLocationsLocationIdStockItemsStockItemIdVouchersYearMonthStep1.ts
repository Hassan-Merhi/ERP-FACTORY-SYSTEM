// Extracted from ./monthly-vouchers.ts to keep that module under the source-size cap.
import type { Request, Response } from "express";
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { calculateHistoricalLocationInventory } from "../helpers/inventoryHistoryHelpers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import type Decimal from "decimal.js";
import {
  containerOffloads,
  containers,
  inventory,
  poLineItems,
  purchaseOrders,
  salesItems,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";

export async function handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1(
  req: Request,
  res: Response
) {
  const locationId = parseInt(req.params.locationId);
  const stockItemId = parseInt(req.params.stockItemId);
  const year = parseInt(req.params.year);
  const month = parseInt(req.params.month);
  const companyId = req.session.currentCompanyId;

  if (!companyId) {
    return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  }

  const stockItem = await storage.getStockItemById(stockItemId);
  if (!stockItem) {
    return { done: true as const, value: res.status(404).json({ message: "Stock item not found" }) };
  }

  const location = await storage.getLocationById(locationId);
  if (!location) {
    return { done: true as const, value: res.status(404).json({ message: "Location not found" }) };
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
  return {
    done: false as const,
    companyId,
    expectedClosingQty,
    expectedClosingRate,
    expectedClosingValue,
    location,
    locationId,
    month,
    monthEndStr,
    monthStartStr,
    openingHistoryRow,
    stockItem,
    stockItemId,
    transactions,
    year,
  };
}
