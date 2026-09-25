import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BarChart3, Building2, ChevronDown, ChevronRight, RefreshCw, Search } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  purchaseCurrencies: string[];
  soldQty: number;
  revenue: number;
  historicalCost: number;
  profit: number;
  avgSellingPrice: number;
  profitPerUnit: number;
  marginPct: number;
  marketStatus: CountryPerformance["status"];
  countries: CountryPerformance[];
}

interface MarketCompanySummary {
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

interface MarketResponse {
  generatedAt: string;
  countries: string[];
  rows: MarketRow[];
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

function StatusBadge({ status }: { status: CountryPerformance["status"] }) {
  if (status === "strong") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Strong</Badge>;
  if (status === "losing") return <Badge variant="destructive">Losing</Badge>;
  if (status === "watch") return <Badge variant="secondary">Watch</Badge>;
  return <Badge variant="outline">No sales</Badge>;
}

function formatNativePurchase(value: number | null, currencies: string[]) {
  if (value == null) return "—";
  if (currencies.length !== 1) return "Mixed currencies";
  const amount = value.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return "$" + amount;
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
  const { selectedCompany, companies } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [stockGroupName, setStockGroupName] = useState("all");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<number[]>([]);
  const [companyPopoverOpen, setCompanyPopoverOpen] = useState(false);
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setStockGroupName("all");
    setExpandedItemKey(null);
    setSelectedCompanyIds(selectedCompany?.id ? [selectedCompany.id] : []);
  }, [selectedCompany?.id]);

  const erpCompanies = useMemo(
    () => companies.filter((company) => company.companyType === "erp" && company.role !== "POS"),
    [companies]
  );

  const multiCompany = selectedCompanyIds.length > 1;

  const toggleCompany = (companyId: number) => {
    setSelectedCompanyIds((current) => {
      if (current.includes(companyId)) {
        return current.length === 1 ? current : current.filter((id) => id !== companyId);
      }
      return [...current, companyId];
    });
    setStockGroupName("all");
    setExpandedItemKey(null);
  };

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (period.fromDate) params.set("startDate", period.fromDate);
    if (period.toDate) params.set("endDate", period.toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (selectedCompanyIds.length > 0) params.set("companyIds", selectedCompanyIds.join(","));
    return `/api/reports/item-market-analysis?${params.toString()}`;
  }, [period, debouncedSearch, selectedCompanyIds]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<MarketResponse, Error>({
    queryKey: [queryUrl, selectedCompany?.id, selectedCompanyIds],
    enabled: selectedCompany?.companyType === "erp" && selectedCompanyIds.length > 0,
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

  const rawRows = data?.rows ?? [];
  const stockGroups = [...new Set(
    rawRows
      .map((row) => row.stockGroupName?.trim())
      .filter((name): name is string => Boolean(name))
  )].sort((left, right) => left.localeCompare(right));

  const rows = rawRows
    .filter((row) => stockGroupName === "all" || row.stockGroupName?.trim() === stockGroupName)
    .sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.companyName.localeCompare(right.companyName)
    );

  const summaryTotals = rows.reduce(
    (totals, row) => {
      totals.importedQty += row.importedQty;
      totals.soldQty += row.soldQty;
      totals.revenue += row.revenue;
      totals.profit += row.profit;
      return totals;
    },
    { importedQty: 0, soldQty: 0, revenue: 0, profit: 0 }
  );
  const summary = {
    itemCount: new Set(rows.map((row) => row.name.trim().toLocaleLowerCase())).size,
    ...summaryTotals,
    marginPct: summaryTotals.revenue === 0 ? 0 : (summaryTotals.profit / summaryTotals.revenue) * 100,
  };

  const selectedCompanyNames = erpCompanies.filter((company) => selectedCompanyIds.includes(company.id));
  const companySummaries = selectedCompanyNames.map((company) => {
    const companyRows = rows.filter((row) => row.companyId === company.id);
    const totals = companyRows.reduce(
      (acc, row) => {
        acc.importedQty += row.importedQty;
        acc.soldQty += row.soldQty;
        acc.revenue += row.revenue;
        acc.profit += row.profit;
        return acc;
      },
      { importedQty: 0, soldQty: 0, revenue: 0, profit: 0 }
    );
    return {
      companyId: company.id,
      companyCode: company.code,
      companyName: company.name,
      itemCount: companyRows.length,
      ...totals,
      marginPct: totals.revenue === 0 ? 0 : (totals.profit / totals.revenue) * 100,
    };
  });

  const topProfitCompanyByItem = new Map<string, string>();
  if (multiCompany) {
    const profitByItem = new Map<string, Map<number, { companyName: string; profit: number }>>();
    for (const row of rows) {
      const itemKey = row.name.trim().toLocaleLowerCase();
      const byCompany = profitByItem.get(itemKey) ?? new Map<number, { companyName: string; profit: number }>();
      const current = byCompany.get(row.companyId);
      byCompany.set(row.companyId, {
        companyName: row.companyName,
        profit: (current?.profit ?? 0) + row.profit,
      });
      profitByItem.set(itemKey, byCompany);
    }

    for (const [itemKey, byCompany] of profitByItem) {
      const values = [...byCompany.values()].sort((left, right) => right.profit - left.profit);
      if (values.length === 0) continue;
      const topProfit = values[0].profit;
      const tied = values.filter((entry) => Math.abs(entry.profit - topProfit) < 0.005);
      topProfitCompanyByItem.set(itemKey, tied.length > 1 ? "Equal" : values[0].companyName);
    }
  }

  const profitClass = summary.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";

  return (
    <div className="container mx-auto space-y-5 p-0 sm:p-6">
      <PageHeader
        title="Item Market Analysis"
        onBack={() => window.history.back()}
        meta={
          <span>
            Imports, sales and historical profit by market
            {multiCompany
              ? ` · ${selectedCompanyIds.length} companies selected`
              : selectedCompanyNames[0]?.name
                ? ` · ${selectedCompanyNames[0].name}`
                : ""}
          </span>
        }
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
        <Popover open={companyPopoverOpen} onOpenChange={setCompanyPopoverOpen}>
          <PopoverTrigger asChild>
            <Button variant="outline" className="w-[190px] justify-between" data-testid="button-item-market-companies">
              <span className="flex items-center gap-2">
                <Building2 className="h-4 w-4" />
                {selectedCompanyIds.length === 1 ? "1 Company" : `${selectedCompanyIds.length} Companies`}
              </span>
              <ChevronDown className="h-4 w-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-72 p-2" align="start">
            <div className="px-2 pb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Compare ERP companies
            </div>
            <div className="max-h-72 space-y-1 overflow-y-auto">
              {erpCompanies.map((company) => (
                <button
                  type="button"
                  key={company.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted"
                  onClick={() => toggleCompany(company.id)}
                  data-testid={`option-item-market-company-${company.id}`}
                >
                  <Checkbox checked={selectedCompanyIds.includes(company.id)} className="h-4 w-4" />
                  <span className="min-w-0 flex-1 truncate text-sm">{company.name}</span>
                  <span className="text-xs text-muted-foreground">{company.code}</span>
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        <Select value={stockGroupName} onValueChange={setStockGroupName}>
          <SelectTrigger className="w-[190px]" data-testid="select-item-market-group">
            <SelectValue placeholder="All groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stock Groups</SelectItem>
            {stockGroups.map((groupName) => (
              <SelectItem key={groupName} value={groupName}>{groupName}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {multiCompany && companySummaries.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {companySummaries.map((company) => {
            const companyProfitClass =
              company.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400";
            return (
              <div key={company.companyId} className="rounded-xl border bg-card p-4">
                <div className="truncate text-sm font-semibold">{company.companyName}</div>
                <div className="text-xs text-muted-foreground">{company.companyCode}</div>
                <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                  <div>
                    <div className="text-muted-foreground">Sold Qty</div>
                    <div className="font-medium tabular-nums">{formatNumber(company.soldQty)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Revenue</div>
                    <div className="font-medium tabular-nums">{formatAmount(company.revenue)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Profit</div>
                    <div className={`font-medium tabular-nums ${companyProfitClass}`}>{formatAmount(company.profit)}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground">Margin</div>
                    <div className="font-medium tabular-nums">{company.marginPct.toFixed(1)}%</div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {isError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
          {error?.message || "Failed to load item market analysis."}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border bg-card">
        <div className="flex items-center gap-2 border-b px-4 py-3">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <div className="font-medium">Item performance</div>
          <div className="ml-auto text-xs text-muted-foreground">
            {multiCompany ? "Same item names are grouped together by company" : "Click an item to see its country breakdown"}
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Item</TableHead>
                {multiCompany && <TableHead>Company</TableHead>}
                <TableHead className="text-right">Imports</TableHead>
                <TableHead className="text-right">Imported Qty</TableHead>
                <TableHead className="text-right">Purchase Value</TableHead>
                <TableHead className="text-right">Avg Purchase</TableHead>
                <TableHead className="text-right">Sold Qty</TableHead>
                <TableHead className="text-right">Avg Sell</TableHead>
                <TableHead className="text-right">Revenue</TableHead>
                <TableHead className="text-right">Profit</TableHead>
                <TableHead className="text-right">Margin</TableHead>
                {multiCompany && <TableHead>Top Profit Company</TableHead>}
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading &&
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={index}>
                    <TableCell colSpan={multiCompany ? 14 : 12}><Skeleton className="h-8 w-full" /></TableCell>
                  </TableRow>
                ))}
              {!isLoading && rows.map((row) => {
                const rowKey = `${row.companyId}:${row.stockItemId}`;
                const expanded = expandedItemKey === rowKey;
                const mixedCurrency = row.purchaseCurrencies.length > 1;
                return (
                  <Fragment key={rowKey}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => setExpandedItemKey(expanded ? null : rowKey)}
                      data-testid={`row-item-market-${row.companyId}-${row.stockItemId}`}
                    >
                      <TableCell>
                        {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                      </TableCell>
                      <TableCell>
                        <div className="max-w-[260px] truncate font-medium">{row.name}</div>
                      </TableCell>
                      {multiCompany && (
                        <TableCell>
                          <div className="font-medium">{row.companyName}</div>
                          <div className="text-xs text-muted-foreground">{row.companyCode}</div>
                        </TableCell>
                      )}
                      <TableCell className="text-right tabular-nums">{formatNumber(row.importCount)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.importedQty)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {mixedCurrency ? (
                          <span className="text-xs text-muted-foreground">Mixed currencies</span>
                        ) : (
                          formatNativePurchase(row.purchaseValue, row.purchaseCurrencies)
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNativePurchase(row.weightedPurchaseCost, row.purchaseCurrencies)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(row.soldQty)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(row.avgSellingPrice)}</TableCell>
                      <TableCell className="text-right tabular-nums">{formatAmount(row.revenue)}</TableCell>
                      <TableCell
                        className={`text-right font-medium tabular-nums ${
                          row.profit < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {formatAmount(row.profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.marginPct.toFixed(1)}%</TableCell>
                      {multiCompany && (
                        <TableCell className="font-medium">
                          {topProfitCompanyByItem.get(row.name.trim().toLocaleLowerCase()) ?? "—"}
                        </TableCell>
                      )}
                      <TableCell><StatusBadge status={row.marketStatus} /></TableCell>
                    </TableRow>
                    {expanded && (
                      <TableRow>
                        <TableCell colSpan={multiCompany ? 14 : 12} className="bg-muted/20 p-0">
                          <div className="p-4">
                            <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
                              <span>
                                Purchase currencies:{" "}
                                {row.purchaseCurrencies.length ? row.purchaseCurrencies.join(", ") : "—"}
                              </span>
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
                                    <TableCell className="text-right tabular-nums">
                                      {formatNumber(market.soldQty)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {formatAmount(market.avgSellingPrice)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {formatAmount(market.historicalCost)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {formatAmount(market.profitPerUnit)}
                                    </TableCell>
                                    <TableCell
                                      className={`text-right font-medium tabular-nums ${
                                        market.profit < 0
                                          ? "text-red-600 dark:text-red-400"
                                          : "text-emerald-600 dark:text-emerald-400"
                                      }`}
                                    >
                                      {formatAmount(market.profit)}
                                    </TableCell>
                                    <TableCell className="text-right tabular-nums">
                                      {market.marginPct.toFixed(1)}%
                                    </TableCell>
                                    <TableCell><StatusBadge status={market.status} /></TableCell>
                                  </TableRow>
                                ))}
                                {row.countries.length === 0 && (
                                  <TableRow>
                                    <TableCell colSpan={8} className="py-6 text-center text-sm text-muted-foreground">
                                      No sales by country for this period.
                                    </TableCell>
                                  </TableRow>
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
                  <TableCell colSpan={multiCompany ? 14 : 12} className="py-10 text-center text-sm text-muted-foreground">
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
