/** Types, helpers and the sale-price breakdown for the Item Market Analysis page. */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";

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

export interface SalePriceBreakdownRow {
  activityType: "sale" | "return";
  unitPrice: number;
  quantity: number;
  revenue: number;
  profit: number;
  transactionCount: number;
}

export interface SalePriceBreakdownResponse {
  rows: SalePriceBreakdownRow[];
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

export const PROFIT_EPSILON = 0.005;

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

export function SalePriceBreakdown({
  companyId,
  stockItemId,
  startDate,
  endDate,
}: {
  companyId: number;
  stockItemId: number;
  startDate?: string;
  endDate?: string;
}) {
  const { formatAmount } = useCurrencyContext();
  const queryUrl = useMemo(() => {
    const params = new URLSearchParams({
      companyId: String(companyId),
      stockItemId: String(stockItemId),
    });
    if (startDate) params.set("startDate", startDate);
    if (endDate) params.set("endDate", endDate);
    return `/api/reports/item-market-analysis/sale-prices?${params.toString()}`;
  }, [companyId, stockItemId, startDate, endDate]);

  const { data, isLoading, isError } = useQuery<SalePriceBreakdownResponse>({
    queryKey: [queryUrl],
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return <Skeleton className="h-24 w-full" />;
  }

  if (isError) {
    return <div className="p-3 text-xs text-destructive">Failed to load sale price breakdown.</div>;
  }

  if (!data?.rows.length) {
    return <div className="p-3 text-xs text-muted-foreground">No sale price history for this item.</div>;
  }

  return (
    <div className="rounded-md border bg-background">
      <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">Sale price breakdown</div>
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Sold Price</TableHead>
              <TableHead className="text-right">Qty</TableHead>
              <TableHead className="text-right">Revenue</TableHead>
              <TableHead className="text-right">Profit</TableHead>
              <TableHead className="text-right">Transactions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((priceRow) => {
              return (
                <TableRow key={`${priceRow.activityType}:${priceRow.unitPrice}`}>
                  <TableCell>
                    <Badge variant={priceRow.activityType === "return" ? "outline" : "secondary"}>
                      {priceRow.activityType === "return" ? "Return" : "Sale"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formatAmount(priceRow.unitPrice)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(priceRow.quantity)}</TableCell>
                  <TableCell className="text-right tabular-nums">{formatAmount(priceRow.revenue)}</TableCell>
                  <TableCell
                    className={`text-right font-medium tabular-nums ${
                      priceRow.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                    }`}
                  >
                    {formatAmount(priceRow.profit)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{formatNumber(priceRow.transactionCount)}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
