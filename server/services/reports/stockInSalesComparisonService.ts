import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import { db } from "../../db";
import { creditNoteItems, locations, salesItems, stockGroups, stockItems, vouchers } from "@shared/schema";
import type { StockInSalesReportMetrics } from "./stockInSalesReportService";
import { getStockInSalesReport } from "./stockInSalesReportService";
import {
  EMPTY_METRICS,
  ZERO,
  addItemFilters,
  decimal,
  divideOrZero,
  indexRows,
  loadAdjustmentItemRows,
  loadStockInItemRows,
  subtractMetrics,
  toNumber,
  type ItemAggregateRow,
  type MutableItemMetrics,
  type StockInSalesComparisonFilters,
  type StockInSalesComparisonResult,
  type StockInSalesComparisonRow,
  type StockInSalesComparisonSideFilters,
  type StockInSalesItemComparisonRow,
} from "./stockInSalesComparisonServiceLoadAdjustmentItemRows";
export type {
  StockInSalesComparisonFilters,
  StockInSalesComparisonResult,
  StockInSalesComparisonRow,
  StockInSalesComparisonSet,
  StockInSalesComparisonSideFilters,
  StockInSalesItemComparisonRow,
} from "./stockInSalesComparisonServiceLoadAdjustmentItemRows";

async function loadSalesItemRows(
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters
): Promise<ItemAggregateRow[]> {
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.voucherType, "Sales"),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  addItemFilters(
    conditions,
    filters,
    side,
    eq(vouchers.locationId, side.locationId),
    filters.search
      ? [
          punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search),
          punctuationInsensitiveSearch(vouchers.locationName, filters.search),
        ]
      : []
  );

  return db
    .select({
      stockItemId: stockItems.id,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      stockGroupId: stockGroups.id,
      stockGroupName: stockGroups.name,
      stockOutQty: sql<string>`COALESCE(SUM(${salesItems.quantity}), 0)`,
      stockOutValue: sql<string>`COALESCE(SUM(${salesItems.totalCost}), 0)`,
      totalSales: sql<string>`COALESCE(SUM(${salesItems.totalSales}), 0)`,
      costOfSales: sql<string>`COALESCE(SUM(${salesItems.totalCost}), 0)`,
      costProfit: sql<string>`COALESCE(SUM(${salesItems.totalSales}::numeric - ${salesItems.totalCost}::numeric), 0)`,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
    .leftJoin(locations, and(eq(vouchers.locationId, locations.id), eq(locations.companyId, filters.companyId)))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(stockItems.id, stockItems.code, stockItems.name, stockGroups.id, stockGroups.name)
    .execute();
}

async function loadNoteItemRows(
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters
): Promise<ItemAggregateRow[]> {
  const sign = sql<number>`CASE WHEN ${vouchers.voucherType} = 'Credit Note' THEN -1 ELSE 1 END`;
  const inventoryValue = sql<number>`(${creditNoteItems.quantity} * ${creditNoteItems.inventoryCost})`;
  const noteProfit = sql<number>`(${creditNoteItems.totalValue} - ${inventoryValue})`;
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    inArray(vouchers.voucherType, ["Credit Note", "Debit Note"]),
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
    eq(creditNoteItems.locationId, side.locationId),
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );

  return db
    .select({
      stockItemId: stockItems.id,
      stockItemCode: stockItems.code,
      stockItemName: stockItems.name,
      stockGroupId: stockGroups.id,
      stockGroupName: stockGroups.name,
      stockOutQty: sql<string>`COALESCE(SUM((${sign}) * ${creditNoteItems.quantity}), 0)`,
      stockOutValue: sql<string>`COALESCE(SUM((${sign}) * ${inventoryValue}), 0)`,
      totalSales: sql<string>`COALESCE(SUM((${sign}) * ${creditNoteItems.totalValue}), 0)`,
      costOfSales: sql<string>`COALESCE(SUM((${sign}) * ${inventoryValue}), 0)`,
      costProfit: sql<string>`COALESCE(SUM((${sign}) * ${noteProfit}), 0)`,
    })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
    .innerJoin(locations, eq(creditNoteItems.locationId, locations.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(stockItems.id, stockItems.code, stockItems.name, stockGroups.id, stockGroups.name)
    .execute();
}

function mergeItemRows(target: Map<number, MutableItemMetrics>, rows: ItemAggregateRow[]): void {
  for (const row of rows) {
    const current = target.get(row.stockItemId) ?? {
      stockItemId: row.stockItemId,
      stockItemCode: row.stockItemCode,
      stockItemName: row.stockItemName,
      stockGroupId: row.stockGroupId,
      stockGroupName: row.stockGroupName || "Unassigned",
      stockInQty: ZERO,
      stockInValue: ZERO,
      stockOutQty: ZERO,
      stockOutValue: ZERO,
      totalSales: ZERO,
      costOfSales: ZERO,
      costProfit: ZERO,
    };
    current.stockInQty = current.stockInQty.plus(decimal(row.stockInQty));
    current.stockInValue = current.stockInValue.plus(decimal(row.stockInValue));
    current.stockOutQty = current.stockOutQty.plus(decimal(row.stockOutQty));
    current.stockOutValue = current.stockOutValue.plus(decimal(row.stockOutValue));
    current.totalSales = current.totalSales.plus(decimal(row.totalSales));
    current.costOfSales = current.costOfSales.plus(decimal(row.costOfSales));
    current.costProfit = current.costProfit.plus(decimal(row.costProfit));
    target.set(row.stockItemId, current);
  }
}

function itemMetricsToReportMetrics(item: MutableItemMetrics): StockInSalesReportMetrics {
  const stockInQty = toNumber(item.stockInQty, 3);
  const stockInValue = toNumber(item.stockInValue, 2);
  const stockOutQty = toNumber(item.stockOutQty, 3);
  const stockOutValue = toNumber(item.stockOutValue, 2);
  const totalSales = toNumber(item.totalSales, 2);
  const costOfSales = toNumber(item.costOfSales, 2);
  const costProfit = toNumber(item.costProfit, 2);
  return {
    openingStockQty: 0,
    openingStockValue: 0,
    stockInQty,
    stockInValue,
    stockInAvgRate: toNumber(divideOrZero(item.stockInValue, item.stockInQty), 6),
    stockAdjustmentQty: 0,
    stockAdjustmentValue: 0,
    totalAvailableQty: stockInQty,
    stockOutQty,
    stockOutValue,
    closingStockQty: toNumber(new Decimal(stockInQty).minus(stockOutQty), 3),
    closingStockValue: toNumber(new Decimal(stockInValue).minus(stockOutValue), 2),
    totalSales,
    costOfSales,
    costProfit,
    avgProfitPerBale: toNumber(divideOrZero(item.costProfit, item.stockOutQty), 6),
  };
}

async function getItemMetricsBySide(
  filters: StockInSalesComparisonFilters,
  side: StockInSalesComparisonSideFilters
): Promise<Map<number, MutableItemMetrics>> {
  const [stockInRows, adjustmentRows, salesRows, noteRows] = await Promise.all([
    loadStockInItemRows(filters, side),
    loadAdjustmentItemRows(filters, side),
    loadSalesItemRows(filters, side),
    loadNoteItemRows(filters, side),
  ]);
  const result = new Map<number, MutableItemMetrics>();
  mergeItemRows(result, stockInRows);
  mergeItemRows(result, adjustmentRows);
  mergeItemRows(result, salesRows);
  mergeItemRows(result, noteRows);
  return result;
}

export async function getStockInSalesComparison(
  filters: StockInSalesComparisonFilters
): Promise<StockInSalesComparisonResult> {
  const common = {
    companyId: filters.companyId,
    startDate: filters.startDate,
    endDate: filters.endDate,
    grouping: filters.grouping,
    profitFilter: "all" as const,
    search: filters.search,
  };

  const [sideAReport, sideBReport, sideAItems, sideBItems] = await Promise.all([
    getStockInSalesReport({
      ...common,
      locationIds: [filters.sideA.locationId],
      stockGroupIds: filters.sideA.stockGroupIds,
    }),
    getStockInSalesReport({
      ...common,
      locationIds: [filters.sideB.locationId],
      stockGroupIds: filters.sideB.stockGroupIds,
    }),
    getItemMetricsBySide(filters, filters.sideA),
    getItemMetricsBySide(filters, filters.sideB),
  ]);

  const sideARows = indexRows(sideAReport.rows);
  const sideBRows = indexRows(sideBReport.rows);
  const periodKeys = Array.from(new Set([...sideARows.keys(), ...sideBRows.keys()])).sort((a, b) => b.localeCompare(a));

  const rows = periodKeys.map((periodKey): StockInSalesComparisonRow => {
    const sideARow = sideARows.get(periodKey);
    const sideBRow = sideBRows.get(periodKey);
    const sideA = sideARow ?? EMPTY_METRICS;
    const sideB = sideBRow ?? EMPTY_METRICS;
    const boundsSource = sideARow ?? sideBRow;

    return {
      periodKey,
      periodStart: boundsSource?.periodStart ?? periodKey,
      periodEnd: boundsSource?.periodEnd ?? periodKey,
      sideA,
      sideB,
      difference: subtractMetrics(sideA, sideB),
    };
  });

  const itemIds = Array.from(new Set([...sideAItems.keys(), ...sideBItems.keys()]));
  const itemRows = itemIds
    .map((stockItemId): StockInSalesItemComparisonRow => {
      const sideAItem = sideAItems.get(stockItemId);
      const sideBItem = sideBItems.get(stockItemId);
      const identity = sideAItem ?? sideBItem;
      const sideA = sideAItem ? itemMetricsToReportMetrics(sideAItem) : EMPTY_METRICS;
      const sideB = sideBItem ? itemMetricsToReportMetrics(sideBItem) : EMPTY_METRICS;
      return {
        stockItemId,
        stockItemCode: identity?.stockItemCode || String(stockItemId),
        stockItemName: identity?.stockItemName || "Unknown item",
        stockGroupId: identity?.stockGroupId ?? null,
        stockGroupName: identity?.stockGroupName || "Unassigned",
        sideA,
        sideB,
        difference: subtractMetrics(sideA, sideB),
      };
    })
    .sort((a, b) => {
      const activityA = Math.abs(a.sideA.totalSales) + Math.abs(a.sideB.totalSales);
      const activityB = Math.abs(b.sideA.totalSales) + Math.abs(b.sideB.totalSales);
      if (activityA !== activityB) return activityB - activityA;
      return a.stockItemName.localeCompare(b.stockItemName);
    });

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      startDate: filters.startDate,
      endDate: filters.endDate,
      grouping: filters.grouping,
      search: filters.search,
      sideA: filters.sideA,
      sideB: filters.sideB,
    },
    summary: {
      sideA: sideAReport.summary,
      sideB: sideBReport.summary,
      difference: subtractMetrics(sideAReport.summary, sideBReport.summary),
    },
    rows,
    rowCount: rows.length,
    itemRows,
    itemRowCount: itemRows.length,
  };
}
