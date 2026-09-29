import Decimal from "decimal.js";
import { and, desc, eq, gte, ilike, inArray, isNull, lte, or, type SQL } from "drizzle-orm";

import { db } from "../../db";
import {
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockGroups,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";

export interface StockInSalesMovementFilters {
  companyId: number;
  startDate: string;
  endDate: string;
  locationIds: number[];
  stockGroupIds: number[];
  search?: string;
  exportAll?: boolean;
}

export interface StockInSalesMovementRow {
  key: string;
  activityDate: string;
  movementType: "Transfer In" | "Transfer Out" | "Adjustment";
  voucherId: number;
  voucherNumber: string;
  locationId: number | null;
  counterpartyLocationId: number | null;
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string;
  quantity: number;
  unitRate: number;
  value: number;
  adjustmentType: string | null;
}

const EXPORT_LIMIT = 20_000;

function number(value: unknown, places: number): number {
  try {
    return Number(
      new Decimal(value === null || value === undefined || value === "" ? 0 : String(value))
        .toDecimalPlaces(places, Decimal.ROUND_HALF_UP)
        .toString()
    );
  } catch {
    return 0;
  }
}

function commonConditions(filters: StockInSalesMovementFilters): SQL[] {
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
    gte(vouchers.voucherDate, filters.startDate),
    lte(vouchers.voucherDate, filters.endDate),
  ];
  if (filters.stockGroupIds.length > 0) conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  if (filters.search) {
    const pattern = `%${filters.search}%`;
    conditions.push(
      or(
        ilike(stockItems.code, pattern),
        ilike(stockItems.name, pattern),
        ilike(stockGroups.name, pattern),
        ilike(vouchers.voucherNumber, pattern)
      )!
    );
  }
  return conditions;
}

export async function getStockInSalesMovementDetails(filters: StockInSalesMovementFilters): Promise<{
  generatedAt: string;
  rows: StockInSalesMovementRow[];
  rowCount: number;
  truncated: boolean;
}> {
  const transferInConditions = commonConditions(filters);
  const transferOutConditions = commonConditions(filters);
  const adjustmentConditions = commonConditions(filters);

  if (filters.locationIds.length > 0) {
    transferInConditions.push(inArray(stockTransferVouchers.destinationLocationId, filters.locationIds));
    transferOutConditions.push(inArray(stockTransferItems.sourceLocationId, filters.locationIds));
    adjustmentConditions.push(inArray(stockAdjustmentVouchers.locationId, filters.locationIds));
  }

  const [transferIn, transferOut, adjustments] = await Promise.all([
    db
      .select({
        id: stockTransferItems.id,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        locationId: stockTransferVouchers.destinationLocationId,
        counterpartyLocationId: stockTransferItems.sourceLocationId,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        quantity: stockTransferItems.quantity,
        rate: stockTransferItems.rate,
        value: stockTransferItems.totalAmount,
      })
      .from(stockTransferItems)
      .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(and(...transferInConditions))
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(stockTransferItems.id))
      .limit(EXPORT_LIMIT),
    db
      .select({
        id: stockTransferItems.id,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        locationId: stockTransferItems.sourceLocationId,
        counterpartyLocationId: stockTransferVouchers.destinationLocationId,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        quantity: stockTransferItems.quantity,
        rate: stockTransferItems.rate,
        value: stockTransferItems.totalAmount,
      })
      .from(stockTransferItems)
      .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
      .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(and(...transferOutConditions))
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(stockTransferItems.id))
      .limit(EXPORT_LIMIT),
    db
      .select({
        id: stockAdjustmentItems.id,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        locationId: stockAdjustmentVouchers.locationId,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        quantity: stockAdjustmentItems.quantity,
        rate: stockAdjustmentItems.rate,
        value: stockAdjustmentItems.totalAmount,
        adjustmentType: stockAdjustmentVouchers.adjustmentType,
      })
      .from(stockAdjustmentItems)
      .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
      .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(and(...adjustmentConditions))
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(stockAdjustmentItems.id))
      .limit(EXPORT_LIMIT),
  ]);

  const rows: StockInSalesMovementRow[] = [
    ...transferIn.map((row) => ({
      key: `transfer-in-${row.id}-${row.locationId}`,
      activityDate: String(row.activityDate),
      movementType: "Transfer In" as const,
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      locationId: row.locationId,
      counterpartyLocationId: row.counterpartyLocationId,
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      quantity: Math.abs(number(row.quantity, 3)),
      unitRate: number(row.rate, 6),
      value: Math.abs(number(row.value, 2)),
      adjustmentType: null,
    })),
    ...transferOut.map((row) => ({
      key: `transfer-out-${row.id}-${row.locationId}`,
      activityDate: String(row.activityDate),
      movementType: "Transfer Out" as const,
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      locationId: row.locationId,
      counterpartyLocationId: row.counterpartyLocationId,
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      quantity: -Math.abs(number(row.quantity, 3)),
      unitRate: number(row.rate, 6),
      value: -Math.abs(number(row.value, 2)),
      adjustmentType: null,
    })),
    ...adjustments.map((row) => {
      const rawQuantity = number(row.quantity, 3);
      const isStockIn =
        row.adjustmentType === "Production" || (row.adjustmentType === "Mixed" && rawQuantity > 0);
      return {
        key: `adjustment-${row.id}-${row.locationId}`,
        activityDate: String(row.activityDate),
        movementType: "Adjustment" as const,
        voucherId: row.voucherId,
        voucherNumber: row.voucherNumber,
        locationId: row.locationId,
        counterpartyLocationId: null,
        stockItemId: row.stockItemId,
        stockItemCode: row.stockItemCode,
        stockItemName: row.stockItemName,
        stockGroupId: row.stockGroupId,
        stockGroupName: row.stockGroupName || "Unassigned",
        quantity: isStockIn ? Math.abs(rawQuantity) : -Math.abs(rawQuantity),
        unitRate: number(row.rate, 6),
        value: isStockIn ? Math.abs(number(row.value, 2)) : -Math.abs(number(row.value, 2)),
        adjustmentType: row.adjustmentType,
      };
    }),
  ].sort((a, b) => {
    const date = b.activityDate.localeCompare(a.activityDate);
    if (date !== 0) return date;
    const voucher = b.voucherNumber.localeCompare(a.voucherNumber);
    if (voucher !== 0) return voucher;
    return a.key.localeCompare(b.key);
  });

  const truncated =
    transferIn.length >= EXPORT_LIMIT || transferOut.length >= EXPORT_LIMIT || adjustments.length >= EXPORT_LIMIT;
  return {
    generatedAt: new Date().toISOString(),
    rows,
    rowCount: rows.length,
    truncated,
  };
}
