// Extracted from ./monthly-vouchers.ts to keep that module under the source-size cap.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db";
import { storage } from "../../storage";
import { toMoney } from "../../lib/money";
import {
  creditNoteItems,
  salesItems,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import { handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1 } from "./handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1";

export async function handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep2({
  companyId,
  locationId,
  month,
  stockItemId,
  transactions,
  year,
}: Pick<
  Extract<
    Awaited<ReturnType<typeof handleGetLocationsLocationIdStockItemsStockItemIdVouchersYearMonthStep1>>,
    { done: false }
  >,
  "companyId" | "locationId" | "month" | "stockItemId" | "transactions" | "year"
>) {
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
  return { noteData };
}
