import { searchAny } from "@shared/searchNormalization";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";

import { db } from "../../db";
import { calculateHistoricalLocationInventory } from "../../routes/helpers/inventoryHistoryHelpers";
import {
  creditNoteItems,
  locations,
  salesItems,
  stockGroups,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import {
  ZERO,
  addCommonItemFilters,
  addTransferItemFilters,
  buildPeriodKeyExpression,
  decimal,
  divideOrZero,
  emptyMetrics,
  enumeratePeriodKeys,
  getAdjustmentRows,
  getPeriodBounds,
  getStockInRows,
  getTransferInRows,
  keyForDate,
  previousDay,
  toNumber,
  type AggregateRow,
  type HistoricalInventoryRow,
  type InventoryBalance,
  type MutableMetrics,
  type StockInSalesReportFilters,
  type StockInSalesReportMetrics,
  type StockInSalesReportResult,
  type StockInSalesReportRow,
} from "./stockInSalesReportServiceGetAdjustmentRows";
export type {
  StockInSalesGrouping,
  StockInSalesProfitFilter,
  StockInSalesReportFilters,
  StockInSalesReportMetrics,
  StockInSalesReportResult,
  StockInSalesReportRow,
} from "./stockInSalesReportServiceGetAdjustmentRows";

async function getSalesRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const periodKey = buildPeriodKeyExpression(sql<string>`${vouchers.voucherDate}`, filters.grouping);
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.voucherType, "Sales"),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  addCommonItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(vouchers.locationId, filters.locationIds) : undefined,
    filters.search
      ? [
          punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search),
          punctuationInsensitiveSearch(vouchers.locationName, filters.search),
        ]
      : []
  );
  return db
    .select({
      periodKey,
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
    .groupBy(periodKey)
    .execute();
}

async function getTransferOutRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
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
    conditions.push(inArray(stockTransferItems.sourceLocationId, filters.locationIds));
  addTransferItemFilters(
    conditions,
    filters,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey,
      stockOutQty: sql<string>`COALESCE(SUM(${stockTransferItems.quantity}), 0)`,
      stockOutValue: sql<string>`COALESCE(SUM(${stockTransferItems.totalAmount}), 0)`,
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

async function getCreditAndDebitNoteRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const periodKey = buildPeriodKeyExpression(sql<string>`${vouchers.voucherDate}`, filters.grouping);
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
  addCommonItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(creditNoteItems.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey,
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
    .groupBy(periodKey)
    .execute();
}

function mergeAggregateRows(
  buckets: Map<string, MutableMetrics>,
  rows: AggregateRow[],
  fields: Array<keyof MutableMetrics>
): void {
  for (const row of rows) {
    if (!row.periodKey) continue;
    const bucket = buckets.get(row.periodKey) ?? emptyMetrics();
    for (const field of fields) bucket[field] = bucket[field].plus(decimal(row[field]));
    buckets.set(row.periodKey, bucket);
  }
}

function historicalRowMatchesFilters(row: HistoricalInventoryRow, filters: StockInSalesReportFilters): boolean {
  if (filters.stockGroupIds.length > 0 && !filters.stockGroupIds.includes(Number(row.stockGroupId))) return false;
  if (!filters.search) return true;
  return searchAny(filters.search, row.stockItemCode, row.stockItemName, row.stockGroupName, row.stockGroupCode);
}

async function getOpeningBalance(filters: StockInSalesReportFilters, asOfDate: string): Promise<InventoryBalance> {
  const balances: HistoricalInventoryRow[][] = await Promise.all(
    filters.locationIds.map((locationId) =>
      calculateHistoricalLocationInventory(locationId, filters.companyId, asOfDate)
    )
  );
  let quantity = ZERO;
  let value = ZERO;
  for (const locationRows of balances) {
    for (const row of locationRows) {
      if (!historicalRowMatchesFilters(row, filters)) continue;
      quantity = quantity.plus(decimal(row.quantity));
      value = value.plus(decimal(row.totalValue));
    }
  }
  return { quantity, value };
}

function toMetrics(metrics: MutableMetrics, opening: InventoryBalance): StockInSalesReportMetrics {
  // Positive stock adjustments are part of Stock In and consumption adjustments
  // are part of Stock Out. stockAdjustment* remains a net informational measure,
  // so it must not be added again here.
  const totalAvailableQty = opening.quantity.plus(metrics.stockInQty);
  const closingStockQty = totalAvailableQty.minus(metrics.stockOutQty);
  const closingStockValue = opening.value.plus(metrics.stockInValue).minus(metrics.stockOutValue);
  return {
    openingStockQty: toNumber(opening.quantity, 3),
    openingStockValue: toNumber(opening.value, 2),
    stockInQty: toNumber(metrics.stockInQty, 3),
    stockInValue: toNumber(metrics.stockInValue, 2),
    stockInAvgRate: toNumber(divideOrZero(metrics.stockInValue, metrics.stockInQty), 6),
    stockAdjustmentQty: toNumber(metrics.stockAdjustmentQty, 3),
    stockAdjustmentValue: toNumber(metrics.stockAdjustmentValue, 2),
    totalAvailableQty: toNumber(totalAvailableQty, 3),
    stockOutQty: toNumber(metrics.stockOutQty, 3),
    stockOutValue: toNumber(metrics.stockOutValue, 2),
    closingStockQty: toNumber(closingStockQty, 3),
    closingStockValue: toNumber(closingStockValue, 2),
    totalSales: toNumber(metrics.totalSales, 2),
    costOfSales: toNumber(metrics.costOfSales, 2),
    costProfit: toNumber(metrics.costProfit, 2),
    avgProfitPerBale: toNumber(divideOrZero(metrics.costProfit, metrics.stockOutQty), 6),
  };
}

function mutableFromPublicMetrics(metrics: StockInSalesReportMetrics): MutableMetrics {
  return {
    stockInQty: decimal(metrics.stockInQty),
    stockInValue: decimal(metrics.stockInValue),
    stockAdjustmentQty: decimal(metrics.stockAdjustmentQty),
    stockAdjustmentValue: decimal(metrics.stockAdjustmentValue),
    stockOutQty: decimal(metrics.stockOutQty),
    stockOutValue: decimal(metrics.stockOutValue),
    totalSales: decimal(metrics.totalSales),
    costOfSales: decimal(metrics.costOfSales),
    costProfit: decimal(metrics.costProfit),
  };
}

export async function getStockInSalesReport(filters: StockInSalesReportFilters): Promise<StockInSalesReportResult> {
  const [stockInRows, transferInRows, adjustmentRows, salesRows, transferOutRows, noteRows] = await Promise.all([
    getStockInRows(filters),
    getTransferInRows(filters),
    getAdjustmentRows(filters),
    getSalesRows(filters),
    getTransferOutRows(filters),
    getCreditAndDebitNoteRows(filters),
  ]);
  const buckets = new Map<string, MutableMetrics>();
  mergeAggregateRows(buckets, stockInRows, ["stockInQty", "stockInValue"]);

  // Internal location transfers are inventory movements, not new stock in or stock out.
  // Keep the queries available for transfer-specific reporting, but intentionally exclude
  // them from the Stock In & Sales movement totals shown in this report.
  void transferInRows;
  void transferOutRows;

  mergeAggregateRows(buckets, adjustmentRows, [
    "stockInQty",
    "stockInValue",
    "stockAdjustmentQty",
    "stockAdjustmentValue",
    "stockOutQty",
    "stockOutValue",
  ]);
  mergeAggregateRows(buckets, salesRows, ["stockOutQty", "stockOutValue", "totalSales", "costOfSales", "costProfit"]);
  mergeAggregateRows(buckets, noteRows, ["stockOutQty", "stockOutValue", "totalSales", "costOfSales", "costProfit"]);

  const observedKeys = Array.from(buckets.keys()).sort();
  if (observedKeys.length === 0 && !filters.startDate) {
    const zeroPublic = toMetrics(emptyMetrics(), { quantity: ZERO, value: ZERO });
    return {
      generatedAt: new Date().toISOString(),
      filters: {
        startDate: filters.startDate,
        endDate: filters.endDate,
        grouping: filters.grouping,
        profitFilter: filters.profitFilter,
        locationIds: filters.locationIds,
        stockGroupIds: filters.stockGroupIds,
        search: filters.search,
      },
      summary: zeroPublic,
      rows: [],
      rowCount: 0,
    };
  }

  const firstKey = filters.startDate ? keyForDate(filters.startDate, filters.grouping) : observedKeys[0];
  const lastKey = filters.endDate
    ? keyForDate(filters.endDate, filters.grouping)
    : (observedKeys[observedKeys.length - 1] ?? firstKey);
  const periodKeys = enumeratePeriodKeys(firstKey, lastKey, filters.grouping);
  for (const key of periodKeys) if (!buckets.has(key)) buckets.set(key, emptyMetrics());

  const chronologicalBuckets = periodKeys.map((periodKey) => ({
    periodKey,
    metrics: buckets.get(periodKey) ?? emptyMetrics(),
    ...getPeriodBounds(periodKey, filters.grouping),
  }));
  const openingDate = previousDay(filters.startDate ?? chronologicalBuckets[0].periodStart);
  let runningOpening = await getOpeningBalance(filters, openingDate);

  const chronologicalRows = chronologicalBuckets.map(
    ({ periodKey, periodStart, periodEnd, metrics }): StockInSalesReportRow => {
      const publicMetrics = toMetrics(metrics, runningOpening);
      const row = { periodKey, periodStart, periodEnd, ...publicMetrics };
      runningOpening = {
        quantity: decimal(publicMetrics.closingStockQty),
        value: decimal(publicMetrics.closingStockValue),
      };
      return row;
    }
  );

  const filteredChronologicalRows = chronologicalRows.filter((row) =>
    filters.profitFilter === "positive"
      ? row.costProfit > 0
      : filters.profitFilter === "negative"
        ? row.costProfit < 0
        : true
  );
  const rows = [...filteredChronologicalRows].sort((a, b) => b.periodKey.localeCompare(a.periodKey));

  let summary: StockInSalesReportMetrics;
  if (filteredChronologicalRows.length === 0) {
    summary = toMetrics(emptyMetrics(), { quantity: ZERO, value: ZERO });
  } else {
    const first = filteredChronologicalRows[0];
    const last = filteredChronologicalRows[filteredChronologicalRows.length - 1];
    const summaryAccumulator = filteredChronologicalRows.reduce<MutableMetrics>((total, row) => {
      const mutable = mutableFromPublicMetrics(row);
      total.stockInQty = total.stockInQty.plus(mutable.stockInQty);
      total.stockInValue = total.stockInValue.plus(mutable.stockInValue);
      total.stockAdjustmentQty = total.stockAdjustmentQty.plus(mutable.stockAdjustmentQty);
      total.stockAdjustmentValue = total.stockAdjustmentValue.plus(mutable.stockAdjustmentValue);
      total.stockOutQty = total.stockOutQty.plus(mutable.stockOutQty);
      total.stockOutValue = total.stockOutValue.plus(mutable.stockOutValue);
      total.totalSales = total.totalSales.plus(mutable.totalSales);
      total.costOfSales = total.costOfSales.plus(mutable.costOfSales);
      total.costProfit = total.costProfit.plus(mutable.costProfit);
      return total;
    }, emptyMetrics());
    summary = toMetrics(summaryAccumulator, {
      quantity: decimal(first.openingStockQty),
      value: decimal(first.openingStockValue),
    });
    summary.closingStockQty = last.closingStockQty;
    summary.closingStockValue = last.closingStockValue;
  }

  return {
    generatedAt: new Date().toISOString(),
    filters: {
      startDate: filters.startDate,
      endDate: filters.endDate,
      grouping: filters.grouping,
      profitFilter: filters.profitFilter,
      locationIds: filters.locationIds,
      stockGroupIds: filters.stockGroupIds,
      search: filters.search,
    },
    summary,
    rows,
    rowCount: rows.length,
  };
}
