// Extracted from ./stockInSalesDetailService.ts to keep that module under the source-size cap.
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { and, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import {
  containerOffloadItems,
  containerOffloads,
  containers,
  locations,
  stockAdjustmentItems,
  stockAdjustmentVouchers,
  stockGroups,
  stockItems,
  vouchers,
} from "@shared/schema";
import type {
  StockInSalesDetailFilters,
  StockInDetailRow,
  StockAdjustmentDetailRow,
  PaginationResult,
} from "./stockInSalesDetailServiceLoadStockInTypes";
export type {
  StockInSalesDetailFilters,
  StockInDetailRow,
  StockOutDetailRow,
  StockAdjustmentDetailRow,
  PaginationResult,
  StockInSalesDetailResult,
} from "./stockInSalesDetailServiceLoadStockInTypes";

export const EXPORT_LIMIT = 20_000;

export function toNumber(value: unknown, decimals: number): number {
  try {
    return Number(
      new Decimal(value === null || value === undefined || value === "" ? 0 : String(value))
        .toDecimalPlaces(decimals, Decimal.ROUND_HALF_UP)
        .toString()
    );
  } catch {
    return 0;
  }
}

export function divideOrZero(numerator: unknown, denominator: unknown): number {
  try {
    const den = new Decimal(denominator === null || denominator === undefined ? 0 : String(denominator));
    if (den.isZero()) return 0;
    return Number(
      new Decimal(numerator === null || numerator === undefined ? 0 : String(numerator))
        .dividedBy(den)
        .toDecimalPlaces(6, Decimal.ROUND_HALF_UP)
        .toString()
    );
  } catch {
    return 0;
  }
}

export function addItemFilters(
  conditions: SQL[],
  filters: StockInSalesDetailFilters,
  locationCondition: SQL | undefined,
  extraSearchConditions: SQL[]
): void {
  if (locationCondition) conditions.push(locationCondition);
  if (filters.stockGroupIds.length > 0) {
    conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  }
  if (filters.search) {
    conditions.push(
      or(
        punctuationInsensitiveSearch(stockItems.code, filters.search),
        punctuationInsensitiveSearch(stockItems.name, filters.search),
        punctuationInsensitiveSearch(stockGroups.name, filters.search),
        punctuationInsensitiveSearch(locations.name, filters.search),
        ...extraSearchConditions
      )!
    );
  }
}

export async function loadStockIn(filters: StockInSalesDetailFilters): Promise<PaginationResult<StockInDetailRow>> {
  const activityDate = sql<string>`COALESCE(${containers.offloadDate}, DATE(${containerOffloads.offloadedAt}))`;
  const conditions: SQL[] = [
    eq(containers.companyId, filters.companyId),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
    eq(containerOffloads.optional, false),
    sql`${activityDate} >= CAST(${filters.startDate} AS date)`,
    sql`${activityDate} <= CAST(${filters.endDate} AS date)`,
  ];

  addItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(containerOffloads.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(containers.containerNumber, filters.search)] : []
  );

  const where = and(...conditions);
  const requestedLimit = filters.exportAll ? EXPORT_LIMIT : filters.limit;
  const requestedPage = filters.exportAll ? 1 : filters.stockInPage;
  const offset = (requestedPage - 1) * requestedLimit;

  const [countResult, rawRows] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(containerOffloadItems)
      .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
      .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
      .innerJoin(stockItems, eq(containerOffloadItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(containerOffloads.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(where),
    db
      .select({
        id: containerOffloadItems.id,
        activityDate,
        containerId: containers.id,
        containerNumber: containers.containerNumber,
        offloadId: containerOffloads.id,
        locationId: locations.id,
        locationName: locations.name,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        quantity: containerOffloadItems.quantity,
        totalValue: containerOffloadItems.totalValue,
      })
      .from(containerOffloadItems)
      .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
      .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
      .innerJoin(stockItems, eq(containerOffloadItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(containerOffloads.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(where)
      .orderBy(desc(activityDate), desc(containers.containerNumber), desc(containerOffloadItems.id))
      .limit(requestedLimit)
      .offset(offset),
  ]);

  const total = Number(countResult[0]?.total || 0);
  const rows: StockInDetailRow[] = rawRows.map((row) => {
    const quantity = toNumber(row.quantity, 3);
    const totalValue = toNumber(row.totalValue, 2);
    return {
      id: row.id,
      activityDate: String(row.activityDate),
      containerId: row.containerId,
      containerNumber: row.containerNumber,
      offloadId: row.offloadId,
      locationId: row.locationId,
      locationName: row.locationName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      quantity,
      avgRate: divideOrZero(totalValue, quantity),
      totalValue,
    };
  });

  return {
    rows,
    total,
    page: requestedPage,
    limit: requestedLimit,
    totalPages: Math.max(1, Math.ceil(total / requestedLimit)),
    truncated: filters.exportAll ? total > rows.length : false,
  };
}

function isAdjustmentStockIn(adjustmentType: string, quantity: number): boolean {
  return adjustmentType === "Production" || (adjustmentType === "Mixed" && quantity > 0);
}

export async function loadAdjustments(
  filters: StockInSalesDetailFilters
): Promise<PaginationResult<StockAdjustmentDetailRow>> {
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
    gte(vouchers.voucherDate, filters.startDate),
    lte(vouchers.voucherDate, filters.endDate),
  ];
  addItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(stockAdjustmentVouchers.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );

  const where = and(...conditions);
  const requestedLimit = filters.exportAll ? EXPORT_LIMIT : filters.limit;

  const [countResult, rawRows] = await Promise.all([
    db
      .select({ total: sql<number>`COUNT(*)::int` })
      .from(stockAdjustmentItems)
      .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
      .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(stockAdjustmentVouchers.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(where),
    db
      .select({
        id: stockAdjustmentItems.id,
        activityDate: vouchers.voucherDate,
        voucherId: vouchers.id,
        voucherNumber: vouchers.voucherNumber,
        locationId: locations.id,
        locationName: locations.name,
        adjustmentType: stockAdjustmentVouchers.adjustmentType,
        stockGroupId: stockGroups.id,
        stockGroupName: stockGroups.name,
        stockItemId: stockItems.id,
        stockItemCode: stockItems.code,
        stockItemName: stockItems.name,
        quantity: stockAdjustmentItems.quantity,
        rate: stockAdjustmentItems.rate,
        totalValue: stockAdjustmentItems.totalAmount,
      })
      .from(stockAdjustmentItems)
      .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
      .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
      .innerJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
      .innerJoin(locations, eq(stockAdjustmentVouchers.locationId, locations.id))
      .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
      .where(where)
      .orderBy(desc(vouchers.voucherDate), desc(vouchers.voucherNumber), desc(stockAdjustmentItems.id))
      .limit(requestedLimit),
  ]);

  const total = Number(countResult[0]?.total || 0);
  const rows: StockAdjustmentDetailRow[] = rawRows.map((row) => {
    const rawQuantity = toNumber(row.quantity, 3);
    const direction = isAdjustmentStockIn(row.adjustmentType, rawQuantity) ? "In" : "Out";
    return {
      id: row.id,
      activityDate: String(row.activityDate),
      voucherId: row.voucherId,
      voucherNumber: row.voucherNumber,
      locationId: row.locationId,
      locationName: row.locationName,
      adjustmentType: row.adjustmentType,
      direction,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      quantity: Math.abs(rawQuantity),
      unitRate: toNumber(row.rate, 6),
      totalValue: Math.abs(toNumber(row.totalValue, 2)),
    };
  });

  return {
    rows,
    total,
    page: 1,
    limit: requestedLimit,
    totalPages: Math.max(1, Math.ceil(total / requestedLimit)),
    truncated: filters.exportAll ? total > rows.length : false,
  };
}
