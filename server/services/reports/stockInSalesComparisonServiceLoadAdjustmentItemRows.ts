// Extracted from ./stockInSalesComparisonService.ts to keep that module under the source-size cap.
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
  vouchers,
} from "@shared/schema";
import type {
  StockInSalesGrouping,
  StockInSalesReportMetrics,
  StockInSalesReportRow,
} from "./stockInSalesReportService";

export interface StockInSalesComparisonSideFilters {
  locationId: number;
  stockGroupIds: number[];
}

export interface StockInSalesComparisonFilters {
  companyId: number;
  startDate?: string;
  endDate?: string;
  grouping: StockInSalesGrouping;
  search?: string;
  sideA: StockInSalesComparisonSideFilters;
  sideB: StockInSalesComparisonSideFilters;
}

export interface StockInSalesComparisonSet {
  sideA: StockInSalesReportMetrics;
  sideB: StockInSalesReportMetrics;
  difference: StockInSalesReportMetrics;
}

export interface StockInSalesComparisonRow extends StockInSalesComparisonSet {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

export interface StockInSalesItemComparisonRow extends StockInSalesComparisonSet {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string;
}

export interface StockInSalesComparisonResult {
  generatedAt: string;
  filters: Omit<StockInSalesComparisonFilters, "companyId">;
  summary: StockInSalesComparisonSet;
  rows: StockInSalesComparisonRow[];
  rowCount: number;
  itemRows: StockInSalesItemComparisonRow[];
  itemRowCount: number;
}

export interface ItemAggregateRow {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  stockInQty?: string | number | null;
  stockInValue?: string | number | null;
  stockOutQty?: string | number | null;
  stockOutValue?: string | number | null;
  totalSales?: string | number | null;
  costOfSales?: string | number | null;
  costProfit?: string | number | null;
}

export interface MutableItemMetrics {
  stockItemId: number;
  stockItemCode: string;
  stockItemName: string;
  stockGroupId: number | null;
  stockGroupName: string;
  stockInQty: Decimal;
  stockInValue: Decimal;
  stockOutQty: Decimal;
  stockOutValue: Decimal;
  totalSales: Decimal;
  costOfSales: Decimal;
  costProfit: Decimal;
}

export const ZERO = new Decimal(0);

export const EMPTY_METRICS: StockInSalesReportMetrics = {
  openingStockQty: 0,
  openingStockValue: 0,
  stockInQty: 0,
  stockInValue: 0,
  stockInAvgRate: 0,
  stockAdjustmentQty: 0,
  stockAdjustmentValue: 0,
  totalAvailableQty: 0,
  stockOutQty: 0,
  stockOutValue: 0,
  closingStockQty: 0,
  closingStockValue: 0,
  totalSales: 0,
  costOfSales: 0,
  costProfit: 0,
  avgProfitPerBale: 0,
};

export function decimal(value: unknown): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  try {
    return new Decimal(String(value));
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

export function subtractMetrics(
  sideA: StockInSalesReportMetrics,
  sideB: StockInSalesReportMetrics
): StockInSalesReportMetrics {
  return {
    openingStockQty: sideA.openingStockQty - sideB.openingStockQty,
    openingStockValue: sideA.openingStockValue - sideB.openingStockValue,
    stockInQty: sideA.stockInQty - sideB.stockInQty,
    stockInValue: sideA.stockInValue - sideB.stockInValue,
    stockInAvgRate: sideA.stockInAvgRate - sideB.stockInAvgRate,
    stockAdjustmentQty: sideA.stockAdjustmentQty - sideB.stockAdjustmentQty,
    stockAdjustmentValue: sideA.stockAdjustmentValue - sideB.stockAdjustmentValue,
    totalAvailableQty: sideA.totalAvailableQty - sideB.totalAvailableQty,
    stockOutQty: sideA.stockOutQty - sideB.stockOutQty,
    stockOutValue: sideA.stockOutValue - sideB.stockOutValue,
    closingStockQty: sideA.closingStockQty - sideB.closingStockQty,
    closingStockValue: sideA.closingStockValue - sideB.closingStockValue,
    totalSales: sideA.totalSales - sideB.totalSales,
    costOfSales: sideA.costOfSales - sideB.costOfSales,
    costProfit: sideA.costProfit - sideB.costProfit,
    avgProfitPerBale: sideA.avgProfitPerBale - sideB.avgProfitPerBale,
  };
}

export function indexRows(rows: StockInSalesReportRow[]): Map<string, StockInSalesReportRow> {
  return new Map(rows.map((row) => [row.periodKey, row]));
}

export function addItemFilters(
  conditions: SQL[],
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters,
  locationCondition: SQL,
  extraSearchConditions: SQL[]
): void {
  conditions.push(locationCondition);
  if (side.stockGroupIds.length > 0) {
    conditions.push(inArray(stockItems.stockGroupId, side.stockGroupIds));
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

export async function loadStockInItemRows(
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters
): Promise<ItemAggregateRow[]> {
  const activityDate = sql<string>`COALESCE(${containers.offloadDate}, DATE(${containerOffloads.offloadedAt}))`;
  const conditions: SQL[] = [
    eq(containers.companyId, filters.companyId),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
    eq(containerOffloads.optional, false),
  ];
  if (filters.startDate) conditions.push(sql`${activityDate} >= CAST(${filters.startDate} AS date)`);
  if (filters.endDate) conditions.push(sql`${activityDate} <= CAST(${filters.endDate} AS date)`);
  addItemFilters(
    conditions,
    filters,
    side,
    eq(containerOffloads.locationId, side.locationId),
    filters.search ? [punctuationInsensitiveSearch(containers.containerNumber, filters.search)] : []
  );

  return db
    .select({
      stockItemId: stockItems.id,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      stockGroupId: stockGroups.id,
      stockGroupName: stockGroups.name,
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
    .groupBy(stockItems.id, stockItems.code, stockItems.name, stockGroups.id, stockGroups.name)
    .execute();
}

export async function loadAdjustmentItemRows(
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters
): Promise<ItemAggregateRow[]> {
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
    eq(locations.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  addItemFilters(
    conditions,
    filters,
    side,
    eq(stockAdjustmentVouchers.locationId, side.locationId),
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );

  return db
    .select({
      stockItemId: stockItems.id,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      stockGroupId: stockGroups.id,
      stockGroupName: stockGroups.name,
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
    })
    .from(stockAdjustmentItems)
    .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
    .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(stockAdjustmentItems.stockItemId, stockItems.id))
    .innerJoin(locations, eq(stockAdjustmentVouchers.locationId, locations.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(stockItems.id, stockItems.code, stockItems.name, stockGroups.id, stockGroups.name)
    .execute();
}
