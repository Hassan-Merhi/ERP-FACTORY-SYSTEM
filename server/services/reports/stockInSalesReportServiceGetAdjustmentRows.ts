// Extracted from ./stockInSalesReportService.ts to keep that module under the source-size cap.
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
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
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import {
  nextPeriodKey,
  type StockInSalesGrouping,
  type StockInSalesReportFilters,
  type AggregateRow,
  type MutableMetrics,
} from "./stockInSalesReportServiceGetAdjustmentRowsHelpers";
export type {
  StockInSalesGrouping,
  StockInSalesProfitFilter,
  StockInSalesReportFilters,
  StockInSalesReportMetrics,
  StockInSalesReportRow,
  StockInSalesReportResult,
  AggregateRow,
  MutableMetrics,
  InventoryBalance,
  HistoricalInventoryRow,
} from "./stockInSalesReportServiceGetAdjustmentRowsHelpers";

export const ZERO = new Decimal(0);

export function decimal(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  try {
    return new Decimal(value);
  } catch {
    return ZERO;
  }
}

export function toNumber(value: Decimal, decimalPlaces: number): number {
  return Number(value.toDecimalPlaces(decimalPlaces, Decimal.ROUND_HALF_UP).toString());
}

export function divideOrZero(numerator: Decimal, denominator: Decimal): Decimal {
  return denominator.isZero() ? ZERO : numerator.dividedBy(denominator);
}

export function emptyMetrics(): MutableMetrics {
  return {
    stockInQty: ZERO,
    stockInValue: ZERO,
    stockAdjustmentQty: ZERO,
    stockAdjustmentValue: ZERO,
    stockOutQty: ZERO,
    stockOutValue: ZERO,
    totalSales: ZERO,
    costOfSales: ZERO,
    costProfit: ZERO,
  };
}

export function buildPeriodKeyExpression(dateExpression: SQL, grouping: StockInSalesGrouping): SQL<string> {
  if (grouping === "monthly") return sql<string>`TO_CHAR(${dateExpression}, 'YYYY-MM')`;
  if (grouping === "yearly") return sql<string>`TO_CHAR(${dateExpression}, 'YYYY')`;
  return sql<string>`TO_CHAR(${dateExpression}, 'YYYY-MM-DD')`;
}

export function getPeriodBounds(
  periodKey: string,
  grouping: StockInSalesGrouping
): { periodStart: string; periodEnd: string } {
  if (grouping === "yearly") return { periodStart: `${periodKey}-01-01`, periodEnd: `${periodKey}-12-31` };
  if (grouping === "monthly") {
    const [year, month] = periodKey.split("-").map(Number);
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return { periodStart: `${periodKey}-01`, periodEnd: `${periodKey}-${String(lastDay).padStart(2, "0")}` };
  }
  return { periodStart: periodKey, periodEnd: periodKey };
}

export function previousDay(isoDate: string): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function enumeratePeriodKeys(startKey: string, endKey: string, grouping: StockInSalesGrouping): string[] {
  const keys: string[] = [];
  let cursor = startKey;
  let guard = 0;
  while (cursor <= endKey && guard < 10000) {
    keys.push(cursor);
    cursor = nextPeriodKey(cursor, grouping);
    guard += 1;
  }
  return keys;
}

export function keyForDate(date: string, grouping: StockInSalesGrouping): string {
  if (grouping === "yearly") return date.slice(0, 4);
  if (grouping === "monthly") return date.slice(0, 7);
  return date;
}

export function addCommonItemFilters(
  conditions: SQL[],
  filters: StockInSalesReportFilters,
  locationCondition: SQL | undefined,
  extras: SQL[]
): void {
  if (locationCondition) conditions.push(locationCondition);
  if (filters.stockGroupIds.length > 0) conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  if (!filters.search) return;
  conditions.push(
    or(
      punctuationInsensitiveSearch(stockItems.code, filters.search),
      punctuationInsensitiveSearch(stockItems.name, filters.search),
      punctuationInsensitiveSearch(stockGroups.name, filters.search),
      punctuationInsensitiveSearch(locations.name, filters.search),
      ...extras
    )!
  );
}

export function addTransferItemFilters(conditions: SQL[], filters: StockInSalesReportFilters, extras: SQL[]): void {
  if (filters.stockGroupIds.length > 0) conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  if (!filters.search) return;
  conditions.push(
    or(
      punctuationInsensitiveSearch(stockItems.code, filters.search),
      punctuationInsensitiveSearch(stockItems.name, filters.search),
      punctuationInsensitiveSearch(stockGroups.name, filters.search),
      ...extras
    )!
  );
}

export async function getStockInRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const activityDate = sql<string>`COALESCE(${containers.offloadDate}, DATE(${containerOffloads.offloadedAt}))`;
  const periodKey = buildPeriodKeyExpression(activityDate, filters.grouping);
  const conditions: SQL[] = [
    eq(containers.companyId, filters.companyId),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
    eq(containerOffloads.optional, false),
  ];
  if (filters.startDate) conditions.push(sql`${activityDate} >= CAST(${filters.startDate} AS date)`);
  if (filters.endDate) conditions.push(sql`${activityDate} <= CAST(${filters.endDate} AS date)`);
  addCommonItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(containerOffloads.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(containers.containerNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey,
      stockInQty: sql<string>`COALESCE(SUM(${containerOffloadItems.quantity}), 0)`,
      stockInValue: sql<string>`COALESCE(SUM(${containerOffloadItems.totalValue}), 0)`,
    })
    .from(containerOffloadItems)
    .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .innerJoin(stockItems, eq(containerOffloadItems.stockItemId, stockItems.id))
    .innerJoin(locations, eq(containerOffloads.locationId, locations.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(periodKey)
    .execute();
}

export async function getTransferInRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const periodKey = buildPeriodKeyExpression(sql<string>`${vouchers.voucherDate}`, filters.grouping);
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  if (filters.locationIds.length > 0)
    conditions.push(inArray(stockTransferVouchers.destinationLocationId, filters.locationIds));
  addTransferItemFilters(
    conditions,
    filters,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey,
      stockInQty: sql<string>`COALESCE(SUM(${stockTransferItems.quantity}), 0)`,
      stockInValue: sql<string>`COALESCE(SUM(${stockTransferItems.totalAmount}), 0)`,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(periodKey)
    .execute();
}

export async function getAdjustmentRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const periodKey = buildPeriodKeyExpression(sql<string>`${vouchers.voucherDate}`, filters.grouping);
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  if (filters.locationIds.length > 0) conditions.push(inArray(stockAdjustmentVouchers.locationId, filters.locationIds));
  addTransferItemFilters(
    conditions,
    filters,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey,
      stockInQty: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN ABS(${stockAdjustmentItems.quantity})
        ELSE 0
      END), 0)`,
      stockInValue: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN ABS(${stockAdjustmentItems.totalAmount})
        ELSE 0
      END), 0)`,
      stockOutQty: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN 0
        ELSE ABS(${stockAdjustmentItems.quantity})
      END), 0)`,
      stockOutValue: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN 0
        ELSE ABS(${stockAdjustmentItems.totalAmount})
      END), 0)`,
      stockAdjustmentQty: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN ABS(${stockAdjustmentItems.quantity})
        ELSE -ABS(${stockAdjustmentItems.quantity})
      END), 0)`,
      stockAdjustmentValue: sql<string>`COALESCE(SUM(CASE
        WHEN ${stockAdjustmentVouchers.adjustmentType} = 'Production'
          OR (${stockAdjustmentVouchers.adjustmentType} = 'Mixed' AND ${stockAdjustmentItems.quantity} > 0)
        THEN ABS(${stockAdjustmentItems.totalAmount})
        ELSE -ABS(${stockAdjustmentItems.totalAmount})
      END), 0)`,
    })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(periodKey)
    .execute();
}
