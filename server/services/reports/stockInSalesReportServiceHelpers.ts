// Extracted from ./stockInSalesReportService.ts
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { and, eq, gte, inArray, isNull, lte, sql, type SQL } from "drizzle-orm";
import { db } from "../../db";
import { creditNoteItems, locations, salesItems, stockGroups, stockItems, vouchers } from "@shared/schema";
import {
  addCommonItemFilters,
  buildPeriodKeyExpression,
  decimal,
  emptyMetrics,
  type AggregateRow,
  type MutableMetrics,
  type StockInSalesReportFilters,
} from "./stockInSalesReportServiceGetAdjustmentRows";

export async function getSalesRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
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

export async function getCreditAndDebitNoteRows(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
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

export function mergeAggregateRows(
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
