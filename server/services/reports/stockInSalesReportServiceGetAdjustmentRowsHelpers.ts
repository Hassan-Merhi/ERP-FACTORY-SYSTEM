// Extracted from ./stockInSalesReportServiceGetAdjustmentRows.ts
import Decimal from "decimal.js";

export type StockInSalesGrouping = "daily" | "monthly" | "yearly";

export type StockInSalesProfitFilter = "all" | "positive" | "negative";

export interface StockInSalesReportFilters {
  companyId: number;
  startDate?: string;
  endDate?: string;
  grouping: StockInSalesGrouping;
  profitFilter: StockInSalesProfitFilter;
  locationIds: number[];
  stockGroupIds: number[];
  search?: string;
}

export interface StockInSalesReportMetrics {
  openingStockQty: number;
  openingStockValue: number;
  stockInQty: number;
  stockInValue: number;
  stockInAvgRate: number;
  stockAdjustmentQty: number;
  stockAdjustmentValue: number;
  totalAvailableQty: number;
  stockOutQty: number;
  stockOutValue: number;
  closingStockQty: number;
  closingStockValue: number;
  totalSales: number;
  costOfSales: number;
  costProfit: number;
  avgProfitPerBale: number;
}

export interface StockInSalesReportRow extends StockInSalesReportMetrics {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

export interface StockInSalesReportResult {
  generatedAt: string;
  filters: Omit<StockInSalesReportFilters, "companyId">;
  summary: StockInSalesReportMetrics;
  rows: StockInSalesReportRow[];
  rowCount: number;
}

export interface AggregateRow {
  periodKey: string;
  stockInQty?: string | number | null;
  stockInValue?: string | number | null;
  stockAdjustmentQty?: string | number | null;
  stockAdjustmentValue?: string | number | null;
  stockOutQty?: string | number | null;
  stockOutValue?: string | number | null;
  totalSales?: string | number | null;
  costOfSales?: string | number | null;
  costProfit?: string | number | null;
}

export interface MutableMetrics {
  stockInQty: Decimal;
  stockInValue: Decimal;
  stockAdjustmentQty: Decimal;
  stockAdjustmentValue: Decimal;
  stockOutQty: Decimal;
  stockOutValue: Decimal;
  totalSales: Decimal;
  costOfSales: Decimal;
  costProfit: Decimal;
}

export interface InventoryBalance {
  quantity: Decimal;
  value: Decimal;
}

export interface HistoricalInventoryRow {
  stockGroupId: number | null;
  stockItemCode: string;
  stockItemName: string;
  stockGroupName: string;
  stockGroupCode: string;
  quantity: string | number | null;
  totalValue: string | number | null;
}

export function nextPeriodKey(periodKey: string, grouping: StockInSalesGrouping): string {
  if (grouping === "yearly") return String(Number(periodKey) + 1);
  if (grouping === "monthly") {
    const [year, month] = periodKey.split("-").map(Number);
    const next = new Date(Date.UTC(year, month, 1));
    return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}`;
  }
  const [year, month, day] = periodKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return next.toISOString().slice(0, 10);
}
