// Extracted from ./RetailDashboard.tsx to keep that module under the source-size cap.
import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export interface DashboardRow {
  product_id?: number;
  location_id?: number;
  variant_id?: number;
  product_name?: string;
  product_code?: string;
  code?: string;
  name?: string;
  brand?: string;
  brand_name?: string;
  color?: string;
  size?: string;
  barcode?: string;
  location_name?: string;
  quantity?: number;
  revenue?: number;
  cogs?: number;
  profit?: number;
  threshold?: number;
  last_sale_at?: string | null;
}

export interface RetailDashboardData {
  period: { from: string; to: string; locationId: number | null };
  summary: {
    inventory_quantity: number;
    inventory_value: number;
    product_count: number;
    variant_count: number;
    low_stock_count: number;
    out_of_stock_count: number;
    revenue: number;
    cogs: number;
    gross_profit: number;
    units_sold: number;
    sale_lines: number;
  };
  bestSellingProducts: DashboardRow[];
  bestSellingBrands: DashboardRow[];
  bestSellingSizes: DashboardRow[];
  salesByLocation: DashboardRow[];
  lowStock: DashboardRow[];
  outOfStock: DashboardRow[];
  slowMoving: DashboardRow[];
  profitByProduct: DashboardRow[];
  profitByBrand: DashboardRow[];
}

export interface RetailAudit {
  ready: boolean;
  errors: number;
  warnings: number;
  issues: Array<{
    code: string;
    severity: "error" | "warning";
    count: number;
    message: string;
  }>;
}

export async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return response.json();
}

export const money = (value: number | undefined) =>
  new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value ?? 0));

export const quantity = (value: number | undefined) =>
  new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Number(value ?? 0));

export function isoDateInput(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function SummaryCard({
  title,
  value,
  subtitle,
  icon,
}: {
  title: string;
  value: string;
  subtitle?: string;
  icon: ReactNode;
}) {
  return (
    <Card>
      <CardContent className="p-4 md:p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
            {subtitle ? <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p> : null}
          </div>
          <div className="rounded-lg border bg-muted/30 p-2 text-muted-foreground">{icon}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export function RankingTable({
  title,
  rows,
  label,
  showProfit = false,
}: {
  title: string;
  rows: DashboardRow[];
  label: (row: DashboardRow) => string;
  showProfit?: boolean;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0 overflow-x-auto">
        <table className="w-full min-w-[420px] text-sm">
          <thead>
            <tr className="border-y bg-muted/30 text-left text-xs text-muted-foreground">
              <th className="px-4 py-2">Name</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2 text-right">Revenue</th>
              {showProfit ? <th className="px-4 py-2 text-right">Profit</th> : null}
            </tr>
          </thead>
          <tbody>
            {rows.length ? (
              rows.map((row, index) => (
                <tr key={`${label(row)}-${index}`} className="border-b last:border-0">
                  <td className="px-4 py-2.5 font-medium">{label(row)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{quantity(row.quantity)}</td>
                  <td className="px-3 py-2.5 text-right tabular-nums">{money(row.revenue)}</td>
                  {showProfit ? <td className="px-4 py-2.5 text-right tabular-nums">{money(row.profit)}</td> : null}
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={showProfit ? 4 : 3} className="px-4 py-8 text-center text-muted-foreground">
                  No activity in this period.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}
