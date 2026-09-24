import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import Decimal from "decimal.js";
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";

import { db } from "../../db";
import {
  creditNoteItems,
  salesItems,
  stockGroups,
  stockItems,
  stockTransferItems,
  stockTransferVouchers,
  vouchers,
} from "@shared/schema";
import type {
  StockInSalesGrouping,
  StockInSalesReportFilters,
  StockInSalesReportResult,
} from "./stockInSalesReportService";

export interface StockInSalesOutboundMetrics {
  salesOutQty: number;
  salesOutValue: number;
  transferOutQty: number;
  transferOutValue: number;
  otherStockOutQty: number;
  otherStockOutValue: number;
  netSalesQty: number;
}

interface AggregateRow {
  periodKey: string;
  quantity?: string | number | null;
  value?: string | number | null;
}
interface MutableBreakdown {
  salesOutQty: Decimal;
  salesOutValue: Decimal;
  transferOutQty: Decimal;
  transferOutValue: Decimal;
  otherStockOutQty: Decimal;
  otherStockOutValue: Decimal;
}
const ZERO = new Decimal(0);
function decimal(value: string | number | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  try {
    return new Decimal(value);
  } catch {
    return ZERO;
  }
}
function toNumber(value: Decimal, places: number): number {
  return Number(value.toDecimalPlaces(places, Decimal.ROUND_HALF_UP).toString());
}
function emptyBreakdown(): MutableBreakdown {
  return {
    salesOutQty: ZERO,
    salesOutValue: ZERO,
    transferOutQty: ZERO,
    transferOutValue: ZERO,
    otherStockOutQty: ZERO,
    otherStockOutValue: ZERO,
  };
}
function periodKey(dateExpression: SQL, grouping: StockInSalesGrouping): SQL<string> {
  if (grouping === "monthly") return sql<string>`TO_CHAR(${dateExpression}, 'YYYY-MM')`;
  if (grouping === "yearly") return sql<string>`TO_CHAR(${dateExpression}, 'YYYY')`;
  return sql<string>`TO_CHAR(${dateExpression}, 'YYYY-MM-DD')`;
}
function addItemFilters(
  conditions: SQL[],
  filters: StockInSalesReportFilters,
  locationCondition?: SQL,
  extra: SQL[] = []
): void {
  if (locationCondition) conditions.push(locationCondition);
  if (filters.stockGroupIds.length > 0) conditions.push(inArray(stockItems.stockGroupId, filters.stockGroupIds));
  if (!filters.search) return;
  conditions.push(
    or(
      punctuationInsensitiveSearch(stockItems.code, filters.search),
      punctuationInsensitiveSearch(stockItems.name, filters.search),
      punctuationInsensitiveSearch(stockGroups.name, filters.search),
      ...extra
    )!
  );
}

async function loadSalesOut(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const key = periodKey(sql<string>`${vouchers.voucherDate}`, filters.grouping);
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
      periodKey: key,
      quantity: sql<string>`COALESCE(SUM(${salesItems.quantity}), 0)`,
      value: sql<string>`COALESCE(SUM(${salesItems.totalCost}), 0)`,
    })
    .from(salesItems)
    .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(key)
    .execute();
}

async function loadSalesNoteAdjustments(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const key = periodKey(sql<string>`${vouchers.voucherDate}`, filters.grouping);
  const sign = sql<number>`CASE WHEN ${vouchers.voucherType} = 'Credit Note' THEN -1 ELSE 1 END`;
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    inArray(vouchers.voucherType, ["Credit Note", "Debit Note"]),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  addItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(creditNoteItems.locationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey: key,
      quantity: sql<string>`COALESCE(SUM((${sign}) * ${creditNoteItems.quantity}), 0)`,
      value: sql<string>`COALESCE(SUM((${sign}) * ${creditNoteItems.quantity} * ${creditNoteItems.inventoryCost}), 0)`,
    })
    .from(creditNoteItems)
    .innerJoin(vouchers, eq(creditNoteItems.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(creditNoteItems.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(key)
    .execute();
}

async function loadTransferOut(filters: StockInSalesReportFilters): Promise<AggregateRow[]> {
  const key = periodKey(sql<string>`${vouchers.voucherDate}`, filters.grouping);
  const conditions: SQL[] = [
    eq(vouchers.companyId, filters.companyId),
    eq(vouchers.optional, false),
    isNull(vouchers.deletedAt),
    eq(stockItems.companyId, filters.companyId),
  ];
  if (filters.startDate) conditions.push(gte(vouchers.voucherDate, filters.startDate));
  if (filters.endDate) conditions.push(lte(vouchers.voucherDate, filters.endDate));
  addItemFilters(
    conditions,
    filters,
    filters.locationIds.length > 0 ? inArray(stockTransferItems.sourceLocationId, filters.locationIds) : undefined,
    filters.search ? [punctuationInsensitiveSearch(vouchers.voucherNumber, filters.search)] : []
  );
  return db
    .select({
      periodKey: key,
      quantity: sql<string>`COALESCE(SUM(${stockTransferItems.quantity}), 0)`,
      value: sql<string>`COALESCE(SUM(${stockTransferItems.totalAmount}), 0)`,
    })
    .from(stockTransferItems)
    .innerJoin(stockTransferVouchers, eq(stockTransferItems.transferId, stockTransferVouchers.id))
    .innerJoin(vouchers, eq(stockTransferVouchers.voucherId, vouchers.id))
    .innerJoin(stockItems, eq(stockTransferItems.stockItemId, stockItems.id))
    .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
    .where(and(...conditions))
    .groupBy(key)
    .execute();
}

function addRows(
  buckets: Map<string, MutableBreakdown>,
  rows: AggregateRow[],
  quantityField: "salesOutQty" | "transferOutQty" | "otherStockOutQty",
  valueField: "salesOutValue" | "transferOutValue" | "otherStockOutValue"
): void {
  for (const row of rows) {
    if (!row.periodKey) continue;
    const bucket = buckets.get(row.periodKey) ?? emptyBreakdown();
    bucket[quantityField] = bucket[quantityField].plus(decimal(row.quantity));
    bucket[valueField] = bucket[valueField].plus(decimal(row.value));
    buckets.set(row.periodKey, bucket);
  }
}
function publicMetrics(value: MutableBreakdown): StockInSalesOutboundMetrics {
  return {
    salesOutQty: toNumber(value.salesOutQty, 3),
    salesOutValue: toNumber(value.salesOutValue, 2),
    transferOutQty: toNumber(value.transferOutQty, 3),
    transferOutValue: toNumber(value.transferOutValue, 2),
    otherStockOutQty: toNumber(value.otherStockOutQty, 3),
    otherStockOutValue: toNumber(value.otherStockOutValue, 2),
    netSalesQty: toNumber(value.salesOutQty, 3),
  };
}

export async function getStockInSalesOutboundBreakdown(
  filters: StockInSalesReportFilters
): Promise<{ summary: StockInSalesOutboundMetrics; rows: Map<string, StockInSalesOutboundMetrics> }> {
  const [salesRows, noteRows, transferRows] = await Promise.all([
    loadSalesOut(filters),
    loadSalesNoteAdjustments(filters),
    loadTransferOut(filters),
  ]);
  const buckets = new Map<string, MutableBreakdown>();
  addRows(buckets, salesRows, "salesOutQty", "salesOutValue");
  addRows(buckets, noteRows, "salesOutQty", "salesOutValue");
  addRows(buckets, transferRows, "transferOutQty", "transferOutValue");
  const total = emptyBreakdown();
  for (const bucket of buckets.values()) {
    total.salesOutQty = total.salesOutQty.plus(bucket.salesOutQty);
    total.salesOutValue = total.salesOutValue.plus(bucket.salesOutValue);
    total.transferOutQty = total.transferOutQty.plus(bucket.transferOutQty);
    total.transferOutValue = total.transferOutValue.plus(bucket.transferOutValue);
    total.otherStockOutQty = total.otherStockOutQty.plus(bucket.otherStockOutQty);
    total.otherStockOutValue = total.otherStockOutValue.plus(bucket.otherStockOutValue);
  }
  return {
    summary: publicMetrics(total),
    rows: new Map(Array.from(buckets.entries()).map(([key, value]) => [key, publicMetrics(value)])),
  };
}

export function applyOutboundBreakdown(
  result: StockInSalesReportResult,
  breakdown: Awaited<ReturnType<typeof getStockInSalesOutboundBreakdown>>
) {
  const zeroOutbound = publicMetrics(emptyBreakdown());
  const enrich = <T extends { totalSales: number; costOfSales: number; avgProfitPerBale: number }>(
    metrics: T,
    outbound: StockInSalesOutboundMetrics
  ) => {
    const costProfit = Number((metrics.totalSales - metrics.costOfSales).toFixed(2));
    const avgProfitPerBale = outbound.netSalesQty === 0 ? 0 : Number((costProfit / outbound.netSalesQty).toFixed(6));
    return { ...metrics, ...outbound, costProfit, avgProfitPerBale };
  };
  const enrichedRows = result.rows.map((row) => enrich(row, breakdown.rows.get(row.periodKey) ?? zeroOutbound));
  const summaryOutbound = enrichedRows.reduce<StockInSalesOutboundMetrics>(
    (total, row) => ({
      salesOutQty: total.salesOutQty + row.salesOutQty,
      salesOutValue: total.salesOutValue + row.salesOutValue,
      transferOutQty: total.transferOutQty + row.transferOutQty,
      transferOutValue: total.transferOutValue + row.transferOutValue,
      otherStockOutQty: total.otherStockOutQty + row.otherStockOutQty,
      otherStockOutValue: total.otherStockOutValue + row.otherStockOutValue,
      netSalesQty: total.netSalesQty + row.netSalesQty,
    }),
    { ...zeroOutbound }
  );
  return { ...result, summary: enrich(result.summary, summaryOutbound), rows: enrichedRows };
}
