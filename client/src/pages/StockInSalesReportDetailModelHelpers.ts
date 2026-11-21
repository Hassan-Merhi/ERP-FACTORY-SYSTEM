// Extracted from ./StockInSalesReportDetailModel.ts
import { formatNumber } from "@/lib/formatNumber";
import type { Metrics, StockInRow, StockOutRow } from "./StockInSalesReportDetailTypes";

export interface StockAdjustmentRow {
  id: number;
  activityDate: string;
  voucherId: number;
  voucherNumber: string;
  locationName: string;
  adjustmentType: string;
  direction: "In" | "Out";
  stockItemId?: number;
  stockItemName: string;
  quantity: number;
  unitRate: number;
  totalValue: number;
}

export interface PagedRows<T> {
  rows: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  truncated: boolean;
}

export interface DetailResponse {
  generatedAt: string;
  period: { startDate: string; endDate: string };
  summary: Metrics;
  stockIn: PagedRows<StockInRow>;
  stockOut: PagedRows<StockOutRow>;
  adjustments?: PagedRows<StockAdjustmentRow>;
}

export interface GroupedStockInRow {
  key: string;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
  dates: string[];
  containers: Array<{ name: string; quantity: number }>;
  locations: Array<{ name: string; quantity: number }>;
}

export interface GroupedSalesRow {
  key: string;
  activityDate: string;
  stockItemName: string;
  quantity: number;
  avgRate: number;
  totalValue: number;
  profitPerBale: number;
  totalProfit: number;
  locations: Array<{ name: string; quantity: number }>;
}

export const EMPTY_METRICS: Metrics = {
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

export function sumMap(target: Map<string, number>, key: string, quantity: number): void {
  target.set(key || "Unassigned", (target.get(key || "Unassigned") || 0) + quantity);
}

export function mapToBreakdown(map: Map<string, number>): Array<{ name: string; quantity: number }> {
  return [...map.entries()]
    .map(([name, quantity]) => ({ name, quantity }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
}

export function groupStockInRows(rows: StockInRow[]): GroupedStockInRow[] {
  const groups = new Map<
    string,
    {
      stockItemName: string;
      quantity: number;
      totalValue: number;
      dates: Set<string>;
      containers: Map<string, number>;
      locations: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const key = String(row.stockItemId ?? row.stockItemName);
    const group = groups.get(key) ?? {
      stockItemName: row.stockItemName,
      quantity: 0,
      totalValue: 0,
      dates: new Set<string>(),
      containers: new Map<string, number>(),
      locations: new Map<string, number>(),
    };
    group.quantity += Number(row.quantity || 0);
    group.totalValue += Number(row.totalValue || 0);
    group.dates.add(row.activityDate);
    sumMap(group.containers, row.containerNumber, Number(row.quantity || 0));
    sumMap(group.locations, row.locationName, Number(row.quantity || 0));
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      stockItemName: group.stockItemName,
      quantity: group.quantity,
      totalValue: group.totalValue,
      avgRate: group.quantity === 0 ? 0 : group.totalValue / group.quantity,
      dates: [...group.dates].sort((a, b) => b.localeCompare(a)),
      containers: mapToBreakdown(group.containers),
      locations: mapToBreakdown(group.locations),
    }))
    .sort((a, b) => a.stockItemName.localeCompare(b.stockItemName, undefined, { numeric: true, sensitivity: "base" }));
}

export function groupSalesRows(rows: StockOutRow[]): GroupedSalesRow[] {
  const groups = new Map<
    string,
    {
      activityDate: string;
      stockItemName: string;
      quantity: number;
      totalValue: number;
      totalProfit: number;
      locations: Map<string, number>;
    }
  >();

  for (const row of rows) {
    const itemKey = String(row.stockItemId ?? row.stockItemName);
    const key = `${row.activityDate}|${itemKey}`;
    const group = groups.get(key) ?? {
      activityDate: row.activityDate,
      stockItemName: row.stockItemName,
      quantity: 0,
      totalValue: 0,
      totalProfit: 0,
      locations: new Map<string, number>(),
    };
    group.quantity += Number(row.quantity || 0);
    group.totalValue += Number(row.totalSales || 0);
    group.totalProfit += Number(row.costProfit || 0);
    sumMap(group.locations, row.locationName, Number(row.quantity || 0));
    groups.set(key, group);
  }

  return [...groups.entries()]
    .map(([key, group]) => ({
      key,
      activityDate: group.activityDate,
      stockItemName: group.stockItemName,
      quantity: group.quantity,
      totalValue: group.totalValue,
      avgRate: group.quantity === 0 ? 0 : group.totalValue / group.quantity,
      profitPerBale: group.quantity === 0 ? 0 : group.totalProfit / group.quantity,
      totalProfit: group.totalProfit,
      locations: mapToBreakdown(group.locations),
    }))
    .sort((a, b) => {
      const date = b.activityDate.localeCompare(a.activityDate);
      if (date !== 0) return date;
      return a.stockItemName.localeCompare(b.stockItemName, undefined, { numeric: true, sensitivity: "base" });
    });
}

export function breakdownTitle(label: string, rows: Array<{ name: string; quantity: number }>): string {
  return `${label}\n${rows.map((row) => `${row.name}: ${formatNumber(row.quantity, 0)}`).join("\n")}`;
}

export function profitClassName(value: number): string {
  if (value > 0) return "text-emerald-500";
  if (value < 0) return "text-red-500";
  return "text-muted-foreground";
}
