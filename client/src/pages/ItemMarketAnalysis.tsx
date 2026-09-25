import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";

interface CountryPerformance {
  country: string;
  soldQty: number;
  revenue: number;
  historicalCost: number;
  profit: number;
  avgSellingPrice: number;
  profitPerUnit: number;
  marginPct: number;
  status: "strong" | "watch" | "losing" | "no_sales";
}

interface MarketRow {
  stockItemId: number;
  code: string;
  name: string;
  stockGroupId: number | null;
  stockGroupName: string | null;
  importCount: number;
  importedQty: number;
  purchaseValue: number | null;
  weightedPurchaseCost: number | null;
  purchaseCurrencies: string[];
  soldQty: number;
  revenue: number;
  historicalCost: number;
  profit: number;
  avgSellingPrice: number;
  profitPerUnit: number;
  marginPct: number;
  marketStatus: CountryPerformance["status"];
  topProfitCountry: CountryPerformance | null;
  countries: CountryPerformance[];
}

interface MarketResponse {
  generatedAt: string;
  countries: string[];
  rows: MarketRow[];
  summary: {
    itemCount: number;
    importedQty: number;
    soldQty: number;
    revenue: number;
    profit: number;
    marginPct: number;
  };
}

interface StockGroupOption {
  id: number;
  name: string;
}

function StatusBadge({ status }: { status: CountryPerformance["status"] }) {
  if (status === "strong") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Strong</Badge>;
  if (status === "losing") return <Badge variant="destructive">Losing</Badge>;
  if (status === "watch") return <Badge variant="secondary">Watch</Badge>;
  return <Badge variant="outline">No sales</Badge>;
}

function formatNativePurchase(value: number | null, currencies: string[]) {
  if (value == null) return "—";
  if (currencies.length !== 1) return "Mixed currencies";
  const currency = currencies[0] === "UNKNOWN" ? "" : currencies[0];
  const amount = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return currency ? `${currency} ${amount}` : amount;
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-xl font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export default function ItemMarketAnalysis() {
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [country, setCountry] = useState("all");
  const [stockGroupId, setStockGroupId] = useState("all");
  const [expandedItemId, setExpandedItemId] = useState<number | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setCountry("all");
    setStockGroupId("all");
    setExpandedItemId(null);
  }, [selectedCompany?.id]);

  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: ["/api/stock-groups", selectedCompany?.id],
    enabled: selectedCompany?.companyType === "erp",
    staleTime: 5 * 60 * 1000,
  });

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (period.fromDate) params.set("startDate", period.fromDate);
    if (period.toDate) params.set("endDate", period.toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (country !== "all") params.set("country", country);
    if (stockGroupId !== "all") params.set("stockGroupId", stockGroupId);
    return `/api/reports/item-market-analysis?${params.toString()}`;
  }, [period, debouncedSearch, country, stockGroupId]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<MarketResponse, Error>({
    queryKey: [queryUrl, selectedCompany?.id],
    enabled: selectedCompany?.companyType === "erp",
    staleTime: 30_000,
  });

  if (selectedCompany && selectedCompany.companyType !== "erp") {
    return (
      <div className="container mx-auto p-4 sm:p-6">
        <PageHeader title="Item Market Analysis" onBack={() => window.history.back()} />
        <div className="mt-6 rounded-xl border p-6 text-sm text-muted-foreground">
          Item Market Analysis is available for ERP companies only.
        </div>
      </div>
    );
  }

  const rows = data?.rows ?? [];
  const summary = data?.summary ?? { itemCount: 0, importedQty: 0, soldQty: 0, revenue: 0, profit: 0, marginPct: 0 };
  const profitClass = summary.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="container mx-auto space-y-5 p-0 sm:p-6">
      <PageHeader
        title="Item Market Analysis"
        onBack={() => window.history.back()}
        meta={<span>Imports, sales and historical profit by market{selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}</span>}
      >
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`mr-2 h-4 w-4 ${isFetching ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </PageHeader>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <MetricCard label="Items" value={formatNumber(summary.itemCount)} />
        <MetricCard label="Imported Qty" value={formatNumber(summary.importedQty)} />
        <MetricCard label="Sold Qty" value={formatNumber(summary.soldQty)} />
        <MetricCard label="Revenue" value={formatAmount(summary.revenue)} />
        <div className="rounded-xl border bg-card p-4">
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Historical Profit</div>
          <div className={`mt-1 text-xl font-semibold tabular-nums ${profitClass}`}>{formatAmount(summary.profit)}</div>
          <div className="text-xs text-muted-foreground">{summary.marginPct.toFixed(1)}% margin</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border bg-card p-3">
        <PeriodFilter value={period} onChange={setPeriod} data-testid="period-filter-item-market-analysis" />
        <div className="relative min-w-[220px] flex-1 sm:max-w-sm">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search item code or name"
            className="pl-8"
            data-testid="input-item-market-search"
          />
        </div>
        <Select value={country} onValueChange={setCountry}>
          <SelectTrigger className="w-[180px]" data-testid="select-item-market-country">
            <SelectValue placeholder="All countries" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Countries</SelectItem>
            {(data?.countries ?? []).map((value) => (
              <SelectItem key={value} value={value}>{value}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={stockGroupId} onValueChange={setStockGroupId}>
          <SelectTrigger className="w-[190px]" data-testid="select-item-market-group">
            <SelectValue placeholder="All groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stock Groups</SelectItem>
            {[...stockGroups].sort((a, b) => a.name.localeCompare(b.name)).map((group) => (
              <SelectItem key={group.id} value={String(group.id)}>{group.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error?.message || "Failed to load item market analysis."}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <div className="font-medium">Item performance</div>
          <div className="ml-auto text-xs text-muted-foreground">Click an item to see its country breakdown</div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Item</TableHead>
                <TableHead className="text-right">Imports</TableHead>
                <TableHead className="text-right">Imported Qty</TableHead>
                <TableHead className="text-right">Purchase Value</TableHead>
                <TableHead className="text-right">Avg Purchase</TableHead>
                <TableHead className="text-right">Sold Qty</TableHead>
                <TableHead className="text-right">Avg Sell</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                <TableHead>Top Profit Country</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={13}><Skeleton className="h-8 w-full" /></TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.map((row) => {
                const expanded = expandedItemId === row.stockItemId;
                const mixedCurrency = row.purchaseCurrencies.length > 1;
                return (
                  <Fragment key={row.stockItemId}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedItemId(expanded ? null : row.stockItemId)}
                      data-testid={`row-item-market-${row.stockItemId}`}
                    >
                      <TableCell>{expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</TableCell>
                      <TableCell>
                        <div className="font-medium">{row.code}</div>
                        <div className="max-w-[260px] truncate text-xs text-muted-foreground">{row.name}</div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.importCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.importedQty)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {mixedCurrency ? <span className="text-xs text-muted-foreground">Mixed currencies</span> : formatNativePurchase(row.purchaseValue, row.purchaseCurrencies)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNativePurchase(row.weightedPurchaseCost, row.purchaseCurrencies)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.soldQty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(row.avgSellingPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(row.revenue)}</TableCell>
                      <TableCell className={`text-right font-medium tabular-nums ${row.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>
                        {formatAmount(row.profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.marginPct.toFixed(1)}%</TableCell>
                      <TableCell>{row.topProfitCountry?.country ?? "—"}</TableCell>
                      <TableCell><StatusBadge status={row.marketStatus} /></TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={13} className="bg-muted/20 p-0">
                          <div className="p-4">
                            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                              <span>Purchase currencies: {row.purchaseCurrencies.length ? row.purchaseCurrencies.join(", ") : "—"}</span>
                              <span>Historical cost sold: {formatAmount(row.historicalCost)}</span>
                              <span>Profit/unit: {formatAmount(row.profitPerUnit)}</span>
                            </div>
                            <Table>
                              <TableHeader>
                                <TableRow>
                                  <TableHead>Country</TableHead>
                                  <TableHead className="text-right">Sold Qty</TableHead>
                                  <TableHead className="text-right">Avg Sell</TableHead>
                                  <TableHead className="text-right">Historical Cost</TableHead>
                                  <TableHead className="text-right">Profit/Unit</TableHead>
                                  <TableHead className="text-right">Total Profit</TableHead>
                                  <TableHead className="text-right">Margin</TableHead>
                                  <TableHead>Status</TableHead>
                                </TableRow>
                              </TableHeader>
                              <TableBody>
                                {row.countries.map((market) => (
                                  <TableRow key={market.country}>
                                    <TableCell className="font-medium">{market.country}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatNumber(market.soldQty)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatAmount(market.avgSellingPrice)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatAmount(market.historicalCost)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatAmount(market.profitPerUnit)}</TableCell>
                                    <TableCell className={`text-right font-medium tabular-nums ${market.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"}`}>{formatAmount(market.profit)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{market.marginPct.toFixed(1)}%</TableCell>
                                    <TableCell><StatusBadge status={market.status} /></TableCell>
                                  </TableRow>
                                ))}
                                {row.countries.length === 0 && (
                                  <TableRow><TableCell colSpan={8} className="py-6 text-center text-sm text-muted-foreground">No sales by country for this period.</TableCell></TableRow>
                                )}
                              </TableBody>
                            </Table>
                          </div>
                        </TableCell>
                      </TableRow>
                    )}
                  </Fragment>
                );
              })}
              {!isLoading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={13} className="py-10 text-center text-sm text-muted-foreground">
                    No imported or sold items match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </div>
    </div>
  );
}
