/** Types and presentational helpers for the Item Market Analysis page. */
import { Badge } from "@/components/ui/badge";

export interface MarketRow {
  companyId: number;
  companyCode: string;
  companyName: string;
  stockItemId: number;
  code: string;
  name: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  importCount: number;
  importedQty: number;
  purchaseValue: number | null;
  weightedPurchaseCost: number | null;
  purchaseValueWithOffloading: number | null;
  weightedPurchaseCostWithOffloading: number | null;
  purchaseCurrencies: string[];
  soldQty: number;
  revenue: number;
  historicalCost: number;
  profit: number;
  avgSellingPrice: number;
  profitPerUnit: number;
  marginPct: number;
  marketStatus: "strong" | "watch" | "losing" | "no_sales";
}

export interface MarketCompanySummary {
  companyId: number;
  companyCode: string;
  companyName: string;
  itemCount: number;
  importedQty: number;
  soldQty: number;
  revenue: number;
  profit: number;
  marginPct: number;
}

export interface MarketResponse {
  generatedAt: string;
  rows: MarketRow[];
  stockGroups: string[];
  companySummaries: MarketCompanySummary[];
  summary: {
    itemCount: number;
    importedQty: number;
    soldQty: number;
    revenue: number;
    profit: number;
    marginPct: number;
  };
}

export function StatusBadge({ status }: { status: MarketRow["marketStatus"] }) {
  if (status === "strong") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Strong</Badge>;
  if (status === "losing") return <Badge variant="destructive">Losing</Badge>;
  if (status === "watch") return <Badge variant="secondary">Watch</Badge>;
  return <Badge variant="outline">No sales</Badge>;
}

export type ProfitDirectionFilter = "all" | "gaining" | "losing" | "none";

const PROFIT_EPSILON = 0.005;

export function normalizeItemCode(code: string) {
  return code.trim().toLocaleUpperCase();
}

export function matchesProfitDirection(profit: number, filter: ProfitDirectionFilter) {
  if (filter === "gaining") return profit > PROFIT_EPSILON;
  if (filter === "losing") return profit < -PROFIT_EPSILON;
  if (filter === "none") return Math.abs(profit) <= PROFIT_EPSILON;
  return true;
}

export function getMarketStatus(soldQty: number, profit: number, marginPct: number): MarketRow["marketStatus"] {
  if (soldQty <= 0) return "no_sales";
  if (profit < 0) return "losing";
  if (marginPct >= 15) return "strong";
  return "watch";
}

export function formatNativePurchase(value: number | null, currencies: string[]) {
  if (value == null) return "—";
  if (currencies.length !== 1) return "Mixed currencies";
  const amount = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return "$" + amount;
}

export function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}
