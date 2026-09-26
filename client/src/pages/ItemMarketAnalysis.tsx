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
  marketStatus: "strong" | "watch" | "losing" | "no_sales";
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

function StatusBadge({ status }: { status: MarketRow["marketStatus"] }) {
  if (status === "strong") return <Badge className="bg-emerald-600 hover:bg-emerald-600">Strong</Badge>;
  if (status === "losing") return <Badge variant="destructive">Losing</Badge>;
  if (status === "watch") return <Badge variant="secondary">Watch</Badge>;
  return <Badge variant="outline">No sales</Badge>;
}

function normalizeItemCode(code: string) {
  return code.trim().toLocaleUpperCase();
}

function getMarketStatus(soldQty: number, profit: number, marginPct: number): MarketRow["marketStatus"] {
  if (soldQty <= 0) return "no_sales";
  if (profit < 0) return "losing";
  if (marginPct >= 15) return "strong";
  return "watch";
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
  const [expandedItemCode, setExpandedItemCode] = useState<string | null>(null);
  const [visibleRowCount, setVisibleRowCount] = useState(250);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setStockGroupName("all");
    setExpandedItemCode(null);
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
    setExpandedItemCode(null);
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
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setVisibleRowCount(250);
    setExpandedItemCode(null);
  }, [queryUrl, stockGroupName, multiCompany]);

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
  const stockGroups = [
    ...new Set(rawRows.map((row) => row.stockGroupName?.trim()).filter((name): name is string => Boolean(name))),
  ].sort((left, right) => left.localeCompare(right));

  const rows = rawRows
    .filter((row) => stockGroupName === "all" || row.stockGroupName?.trim() === stockGroupName)
    .sort(
      (left, right) =>
        normalizeItemCode(left.code).localeCompare(normalizeItemCode(right.code)) ||
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
    itemCount: new Set(rows.map((row) => normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`)).size,
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

  const topProfitCompanyByItem = new Map<
    string,
    { kind: "winner"; companyName: string; profit: number; marginPct: number } | { kind: "equal" } | { kind: "none" }
  >();

  const profitByCode = new Map<string, Map<number, { companyName: string; profit: number; revenue: number }>>();

  for (const row of rows) {
    const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
    const byCompany =
      profitByCode.get(itemKey) ?? new Map<number, { companyName: string; profit: number; revenue: number }>();
    const current = byCompany.get(row.companyId);
    byCompany.set(row.companyId, {
      companyName: row.companyName,
      profit: (current?.profit ?? 0) + row.profit,
      revenue: (current?.revenue ?? 0) + row.revenue,
    });
    profitByCode.set(itemKey, byCompany);
  }

  for (const [itemKey, byCompany] of profitByCode) {
    // "Top Profit Company" should only identify a market that actually made
    // positive profit. A company with no sales (profit = 0) must never beat a
    // company that sold the item at a loss, and if nobody made money we show None.
    const profitableValues = [...byCompany.values()]
      .filter((entry) => entry.revenue > 0 && entry.profit > 0)
      .sort((left, right) => right.profit - left.profit);

    if (profitableValues.length === 0) {
      topProfitCompanyByItem.set(itemKey, { kind: "none" });
      continue;
    }

    const topProfit = profitableValues[0].profit;
    const tied = profitableValues.filter((entry) => Math.abs(entry.profit - topProfit) < 0.005);

    if (tied.length > 1) {
      topProfitCompanyByItem.set(itemKey, { kind: "equal" });
      continue;
    }

    const best = profitableValues[0];
    topProfitCompanyByItem.set(itemKey, {
      kind: "winner",
      companyName: best.companyName,
      profit: best.profit,
      marginPct: best.revenue === 0 ? 0 : (best.profit / best.revenue) * 100,
    });
  }

  const groupedRows = (() => {
    const grouped = new Map<string, MarketRow[]>();

    for (const row of rows) {
      const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
      grouped.set(itemKey, [...(grouped.get(itemKey) ?? []), row]);
    }

    return [...grouped.entries()]
      .map(([itemKey, companyRows]) => {
        const orderedRows = [...companyRows].sort((left, right) => left.companyName.localeCompare(right.companyName));
        const firstRow = orderedRows[0]!;
        const importCount = orderedRows.reduce((sum, row) => sum + row.importCount, 0);
        const importedQty = orderedRows.reduce((sum, row) => sum + row.importedQty, 0);
        const soldQty = orderedRows.reduce((sum, row) => sum + row.soldQty, 0);
        const revenue = orderedRows.reduce((sum, row) => sum + row.revenue, 0);
        const historicalCost = orderedRows.reduce((sum, row) => sum + row.historicalCost, 0);
        const profit = orderedRows.reduce((sum, row) => sum + row.profit, 0);
        const purchaseCurrencies = [...new Set(orderedRows.flatMap((row) => row.purchaseCurrencies))];
        const purchaseValue =
          purchaseCurrencies.length === 1 && orderedRows.every((row) => row.purchaseValue != null)
            ? orderedRows.reduce((sum, row) => sum + (row.purchaseValue ?? 0), 0)
            : null;
        const weightedPurchaseCost = purchaseValue != null && importedQty !== 0 ? purchaseValue / importedQty : null;
        const avgSellingPrice = soldQty === 0 ? 0 : revenue / soldQty;
        const profitPerUnit = soldQty === 0 ? 0 : profit / soldQty;
        const marginPct = revenue === 0 ? 0 : (profit / revenue) * 100;

        return {
          itemKey,
          code: firstRow.code,
          name: firstRow.name,
          stockGroupName: firstRow.stockGroupName,
          companyRows: orderedRows,
          importCount,
          importedQty,
          purchaseValue,
          weightedPurchaseCost,
          purchaseCurrencies,
          soldQty,
          revenue,
          historicalCost,
          profit,
          avgSellingPrice,
          profitPerUnit,
          marginPct,
          marketStatus: getMarketStatus(soldQty, profit, marginPct),
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name) || left.itemKey.localeCompare(right.itemKey));
  })();

  const visibleRows = rows.slice(0, visibleRowCount);
  const visibleGroupedRows = groupedRows.slice(0, visibleRowCount);
  const totalVisibleSourceRows = multiCompany ? groupedRows.length : rows.length;

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
        <Select
          value={stockGroupName}
          onValueChange={(value) => {
            setStockGroupName(value);
            setExpandedItemCode(null);
          }}
        >
          <SelectTrigger className="w-[190px]" data-testid="select-item-market-group">
            <SelectValue placeholder="All groups" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Stock Groups</SelectItem>
            {stockGroups.map((groupName) => (
              <SelectItem key={groupName} value={groupName}>
                {groupName}
              </SelectItem>
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
                    <div className={`font-medium tabular-nums ${companyProfitClass}`}>
                      {formatAmount(company.profit)}
                    </div>
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
            {multiCompany
              ? "Items are matched by code · expand Companies to compare each company"
              : "Historical item performance for this company"}
          </div>
        </div>
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
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
                    <TableCell colSpan={multiCompany ? 13 : 11}>
                      <Skeleton className="h-8 w-full" />
                    </TableCell>
                  </TableRow>
                ))}

              {!isLoading &&
                multiCompany &&
                visibleGroupedRows.map((group) => {
                  const expanded = expandedItemCode === group.itemKey;
                  const mixedCurrency = group.purchaseCurrencies.length > 1;
                  const topCompany = topProfitCompanyByItem.get(group.itemKey);
                  const topProfitClass = "text-emerald-600 dark:text-emerald-400";

                  return (
                    <Fragment key={group.itemKey}>
                      <TableRow data-testid={`row-item-market-group-${group.itemKey}`}>
                        <TableCell>
                          <div className="max-w-[260px] truncate font-medium">{group.name}</div>
                        </TableCell>
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-8 gap-1.5 px-2"
                            onClick={() => setExpandedItemCode(expanded ? null : group.itemKey)}
                            data-testid={`button-item-market-expand-${group.itemKey}`}
                          >
                            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            {selectedCompanyNames.length} Companies
                          </Button>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(group.importCount)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(group.importedQty)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {mixedCurrency ? (
                            <span className="text-xs text-muted-foreground">Mixed currencies</span>
                          ) : (
                            formatNativePurchase(group.purchaseValue, group.purchaseCurrencies)
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatNativePurchase(group.weightedPurchaseCost, group.purchaseCurrencies)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatNumber(group.soldQty)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatAmount(group.avgSellingPrice)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatAmount(group.revenue)}</TableCell>
                        <TableCell
                          className={`text-right font-medium tabular-nums ${
                            group.profit < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-emerald-600 dark:text-emerald-400"
                          }`}
                        >
                          {formatAmount(group.profit)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{group.marginPct.toFixed(1)}%</TableCell>
                        <TableCell>
                          {topCompany?.kind === "equal" ? (
                            <span className="font-medium">Equal</span>
                          ) : topCompany?.kind === "winner" ? (
                            <div>
                              <div className="font-medium">{topCompany.companyName}</div>
                              <div className={`text-xs tabular-nums ${topProfitClass}`}>
                                {formatAmount(topCompany.profit)} · {topCompany.marginPct.toFixed(1)}%
                              </div>
                            </div>
                          ) : (
                            <span className="text-muted-foreground">None</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <StatusBadge status={group.marketStatus} />
                        </TableCell>
                      </TableRow>

                      {expanded && (
                        <TableRow key={`${group.itemKey}:companies`}>
                          <TableCell colSpan={13} className="bg-muted/20 p-0">
                            <div className="p-3">
                              <div className="mb-2 text-xs font-medium text-muted-foreground">
                                Company breakdown for {group.name}
                              </div>
                              <div className="overflow-x-auto rounded-md border">
                                <Table>
                                  <TableHeader>
                                    <TableRow>
                                      <TableHead>Company</TableHead>
                                      <TableHead className="text-right">Imports</TableHead>
                                      <TableHead className="text-right">Imported Qty</TableHead>
                                      <TableHead className="text-right">Purchase Value</TableHead>
                                      <TableHead className="text-right">Avg Purchase</TableHead>
                                      <TableHead className="text-right">Sold Qty</TableHead>
                                      <TableHead className="text-right">Avg Sell</TableHead>
                                      <TableHead className="text-right">Revenue</TableHead>
                                      <TableHead className="text-right">Profit</TableHead>
                                      <TableHead className="text-right">Margin</TableHead>
                                      <TableHead>Status</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {selectedCompanyNames.map((company) => {
                                      const row = group.companyRows.find((entry) => entry.companyId === company.id);
                                      if (!row) {
                                        return (
                                          <TableRow key={company.id}>
                                            <TableCell>
                                              <div className="font-medium">{company.name}</div>
                                              <div className="text-xs text-muted-foreground">{company.code}</div>
                                            </TableCell>
                                            <TableCell
                                              colSpan={10}
                                              className="text-center text-xs text-muted-foreground"
                                            >
                                              No import or sales activity for this item code in the selected period.
                                            </TableCell>
                                          </TableRow>
                                        );
                                      }

                                      const rowMixedCurrency = row.purchaseCurrencies.length > 1;
                                      return (
                                        <TableRow key={company.id}>
                                          <TableCell>
                                            <div className="font-medium">{row.companyName}</div>
                                            <div className="text-xs text-muted-foreground">{row.companyCode}</div>
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatNumber(row.importCount)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatNumber(row.importedQty)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {rowMixedCurrency ? (
                                              <span className="text-xs text-muted-foreground">Mixed currencies</span>
                                            ) : (
                                              formatNativePurchase(row.purchaseValue, row.purchaseCurrencies)
                                            )}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatNativePurchase(row.weightedPurchaseCost, row.purchaseCurrencies)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatNumber(row.soldQty)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatAmount(row.avgSellingPrice)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {formatAmount(row.revenue)}
                                          </TableCell>
                                          <TableCell
                                            className={`text-right font-medium tabular-nums ${
                                              row.profit < 0
                                                ? "text-red-600 dark:text-red-400"
                                                : "text-emerald-600 dark:text-emerald-400"
                                            }`}
                                          >
                                            {formatAmount(row.profit)}
                                          </TableCell>
                                          <TableCell className="text-right tabular-nums">
                                            {row.marginPct.toFixed(1)}%
                                          </TableCell>
                                          <TableCell>
                                            <StatusBadge status={row.marketStatus} />
                                          </TableCell>
                                        </TableRow>
                                      );
                                    })}
                                  </TableBody>
                                </Table>
                              </div>
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}

              {!isLoading &&
                !multiCompany &&
                visibleRows.map((row) => {
                  const rowKey = `${row.companyId}:${row.stockItemId}`;
                  const mixedCurrency = row.purchaseCurrencies.length > 1;
                  return (
                    <TableRow key={rowKey} data-testid={`row-item-market-${row.companyId}-${row.stockItemId}`}>
                      <TableCell>
                        <div className="max-w-[260px] truncate font-medium">{row.name}</div>
                      </TableCell>
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
                          row.profit < 0 ? "text-red-600 dark:text-red-400" : "text-emerald-600 dark:text-emerald-400"
                        }`}
                      >
                        {formatAmount(row.profit)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{row.marginPct.toFixed(1)}%</TableCell>
                      <TableCell>
                        <StatusBadge status={row.marketStatus} />
                      </TableCell>
                    </TableRow>
                  );
                })}

              {!isLoading && (multiCompany ? groupedRows.length === 0 : rows.length === 0) && (
                <TableRow>
                  <TableCell
                    colSpan={multiCompany ? 13 : 11}
                    className="py-10 text-center text-sm text-muted-foreground"
                  >
                    No imported or sold items match these filters.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        {!isLoading && visibleRowCount < totalVisibleSourceRows && (
          <div className="flex items-center justify-between border-t px-4 py-3">
            <div className="text-xs text-muted-foreground">
              Showing {formatNumber(Math.min(visibleRowCount, totalVisibleSourceRows))} of{" "}
              {formatNumber(totalVisibleSourceRows)} items
            </div>
            <Button variant="outline" size="sm" onClick={() => setVisibleRowCount((count) => count + 250)}>
              Load 250 more
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
