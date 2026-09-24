import { useEffect, useMemo, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { differenceInCalendarDays, format, parseISO } from "date-fns";
import {
  ChevronDown,
  ChevronRight,
  Coins,
  Download,
  FileSpreadsheet,
  FileText,
  GitCompare,
  PackageMinus,
  PackagePlus,
  RefreshCw,
  TrendingDown,
  TrendingUp,
} from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { PeriodFilter, getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { ExcelJS, writeFile } from "@/lib/excelHelper";
import { formatNumber } from "@/lib/formatNumber";
import StockInSalesReportComparison from "./StockInSalesReportComparison";
import StockInSalesReportDetail from "./StockInSalesReportDetail";

interface LocationOption {
  id: number;
  name: string;
}

interface StockGroupOption {
  id: number;
  name: string;
}

interface StockInSalesMetrics {
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
  salesOutQty?: number;
  salesOutValue?: number;
  transferOutQty?: number;
  transferOutValue?: number;
  otherStockOutQty?: number;
  otherStockOutValue?: number;
  netSalesQty?: number;
}

interface StockInSalesRow extends StockInSalesMetrics {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

interface StockInSalesResponse {
  generatedAt: string;
  summary: StockInSalesMetrics;
  rows: StockInSalesRow[];
  rowCount: number;
}

type ReportGrouping = "daily" | "monthly" | "yearly";

function resolveGrouping(period: PeriodFilterValue): ReportGrouping {
  if (["today", "yesterday", "this_week", "this_month", "last_1_month"].includes(period.preset)) {
    return "daily";
  }
  if (period.preset === "this_year" || period.preset === "last_6_months") return "monthly";
  if (period.preset === "all_time") return "yearly";

  if (period.fromDate && period.toDate) {
    try {
      const days = Math.abs(differenceInCalendarDays(parseISO(period.toDate), parseISO(period.fromDate))) + 1;
      if (days <= 45) return "daily";
      if (days <= 730) return "monthly";
      return "yearly";
    } catch {
      return "monthly";
    }
  }

  return "monthly";
}

function MultiSelectFilter<T extends { id: number; name: string }>({
  label,
  singularLabel,
  items,
  selectedIds,
  onChange,
  testId,
}: {
  label: string;
  singularLabel: string;
  items: T[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  testId: string;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5" data-testid={testId}>
          {selectedIds.length === 0
            ? `All ${label}`
            : `${selectedIds.length} ${singularLabel}${selectedIds.length === 1 ? "" : "s"}`}
          <ChevronDown className="h-3 w-3" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-2" align="start">
        <div className="max-h-72 space-y-1 overflow-y-auto">
          <div
            className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover-elevate"
            onClick={() => onChange([])}
            data-testid={`${testId}-all`}
          >
            <Checkbox checked={selectedIds.length === 0} className="pointer-events-none h-4 w-4" />
            <span className="text-sm font-medium">All {label}</span>
          </div>
          <div className="my-1 border-t" />
          {items.map((item) => {
            const id = String(item.id);
            const selected = selectedIds.includes(id);
            return (
              <div
                key={item.id}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 hover-elevate"
                onClick={() => onChange(selected ? selectedIds.filter((value) => value !== id) : [...selectedIds, id])}
                data-testid={`${testId}-option-${item.id}`}
              >
                <Checkbox checked={selected} className="pointer-events-none h-4 w-4" />
                <span className="text-sm">{item.name}</span>
              </div>
            );
          })}
          {items.length === 0 && <p className="px-2 py-3 text-xs text-muted-foreground">No options available</p>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SummaryPill({
  label,
  value,
  icon: Icon,
  tone = "default",
  testId,
}: {
  label: string;
  value: string;
  icon: LucideIcon;
  tone?: "default" | "positive" | "negative";
  testId: string;
}) {
  const toneClass =
    tone === "positive"
      ? "text-emerald-600 dark:text-emerald-400"
      : tone === "negative"
        ? "text-red-600 dark:text-red-400"
        : "text-foreground";

  return (
    <div className="flex min-h-10 items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
      <Icon className={`h-4 w-4 ${tone === "default" ? "text-muted-foreground" : toneClass}`} />
      <div className="min-w-0">
        <div className="text-[11px] text-muted-foreground">{label}</div>
        <div className={`font-mono text-sm font-semibold ${toneClass}`} data-testid={testId}>
          {value}
        </div>
      </div>
    </div>
  );
}

const EMPTY_METRICS: StockInSalesMetrics = {
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

export default function StockInSalesReport() {
  const view = new URLSearchParams(window.location.search).get("view");
  if (view === "detail") return <StockInSalesReportDetail />;
  if (view === "comparison") return <StockInSalesReportComparison />;
  return <StockInSalesReportSummary />;
}

function StockInSalesReportSummary() {
  const { selectedCompany } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("this_year"));
  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedStockGroups, setSelectedStockGroups] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [isExporting, setIsExporting] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(searchTerm.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  useEffect(() => {
    setSelectedLocations([]);
    setSelectedStockGroups([]);
  }, [selectedCompany?.id]);

  const { data: locations = [] } = useQuery<LocationOption[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: ["/api/stock-groups", selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });

  const sortedLocations = useMemo(() => [...locations].sort((a, b) => a.name.localeCompare(b.name)), [locations]);
  const sortedStockGroups = useMemo(() => [...stockGroups].sort((a, b) => a.name.localeCompare(b.name)), [stockGroups]);
  const grouping = useMemo(() => resolveGrouping(periodFilter), [periodFilter]);
  const periodColumnLabel = grouping === "daily" ? "Day" : grouping === "yearly" ? "Year" : "Month";

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (periodFilter.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter.toDate) params.set("endDate", periodFilter.toDate);
    params.set("grouping", grouping);
    params.set("profitFilter", "all");
    if (selectedLocations.length > 0) params.set("locationIds", selectedLocations.join(","));
    if (selectedStockGroups.length > 0) params.set("stockGroupIds", selectedStockGroups.join(","));
    if (debouncedSearch) params.set("search", debouncedSearch);
    return `/api/reports/stock-in-sales?${params.toString()}`;
  }, [periodFilter, grouping, selectedLocations, selectedStockGroups, debouncedSearch]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<StockInSalesResponse, Error>({
    queryKey: [queryUrl, selectedCompany?.id],
    enabled: !!selectedCompany?.id,
    staleTime: 30_000,
  });

  const summary = data?.summary ?? EMPTY_METRICS;
  const rows = data?.rows ?? [];
  const formatSignedAmount = (value: number) => (value < 0 ? `-${formatAmount(Math.abs(value))}` : formatAmount(value));
  const formatRoundedAmount = (value: number) => formatAmount(Math.round(value));
  const formatSignedRoundedAmount = (value: number) =>
    value < 0 ? `-${formatAmount(Math.round(Math.abs(value)))}` : formatAmount(Math.round(value));
  const formatPeriodLabel = (row: StockInSalesRow) => {
    try {
      if (grouping === "daily") return format(parseISO(row.periodKey), "EEE, MMM d, yyyy");
      if (grouping === "yearly") return row.periodKey;
      return format(parseISO(`${row.periodKey}-01`), "MMMM yyyy");
    } catch {
      return row.periodKey;
    }
  };

  const clearFilters = () => {
    setPeriodFilter(getDefaultPeriodValue("this_year"));
    setSelectedLocations([]);
    setSelectedStockGroups([]);
    setSearchTerm("");
    setDebouncedSearch("");
  };

  const openDetail = (row: StockInSalesRow) => {
    const params = new URLSearchParams({
      view: "detail",
      startDate: row.periodStart,
      endDate: row.periodEnd,
      periodLabel: formatPeriodLabel(row),
    });
    if (selectedLocations.length > 0) params.set("locationIds", selectedLocations.join(","));
    if (selectedStockGroups.length > 0) params.set("stockGroupIds", selectedStockGroups.join(","));
    if (debouncedSearch) params.set("search", debouncedSearch);
    window.location.assign(`/stock-in-sales-report?${params.toString()}`);
  };

  const openComparison = () => {
    const params = new URLSearchParams({ view: "comparison", grouping });
    if (periodFilter.fromDate) params.set("startDate", periodFilter.fromDate);
    if (periodFilter.toDate) params.set("endDate", periodFilter.toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (selectedLocations[0]) params.set("sideALocationId", selectedLocations[0]);
    if (selectedLocations[1]) params.set("sideBLocationId", selectedLocations[1]);
    if (selectedStockGroups.length > 0) {
      params.set("sideAStockGroupIds", selectedStockGroups.join(","));
      params.set("sideBStockGroupIds", selectedStockGroups.join(","));
    }
    window.location.assign(`/stock-in-sales-report?${params.toString()}`);
  };

  const exportExcel = async () => {
    if (!data || rows.length === 0) return;
    setIsExporting(true);
    try {
      const workbook = new ExcelJS.Workbook();
      const sheet = workbook.addWorksheet("Stock In & Sales");
      sheet.columns = [
        { header: periodColumnLabel, key: "period", width: 22 },
        { header: "Opening Qty", key: "openingStockQty", width: 16 },
        { header: "Stock In", key: "stockInQty", width: 16 },
        { header: "Stock Out", key: "stockOutQty", width: 16 },
        { header: "Closing Qty", key: "closingStockQty", width: 16 },
        { header: "Closing Value", key: "closingStockValue", width: 18 },
        { header: "Sales", key: "totalSales", width: 18 },
        { header: "Gross Profit", key: "costProfit", width: 18 },
      ];
      rows.forEach((row) => sheet.addRow({ period: formatPeriodLabel(row), ...row }));
      sheet.getRow(1).font = { bold: true };
      await writeFile(workbook, `stock-in-sales-report-${format(new Date(), "yyyy-MM-dd")}.xlsx`);
    } catch (exportError: unknown) {
      toast({
        title: "Export failed",
        description: (exportError instanceof Error ? exportError.message : "") || "Unable to create the Excel file.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const exportCsv = () => {
    if (rows.length === 0) return;
    const headers = [
      periodColumnLabel,
      "Opening Qty",
      "Stock In",
      "Stock Out",
      "Closing Qty",
      "Closing Value",
      "Sales",
      "Gross Profit",
    ];
    const values = rows.map((row) => [
      formatPeriodLabel(row),
      row.openingStockQty,
      row.stockInQty,
      row.stockOutQty,
      row.closingStockQty,
      row.closingStockValue,
      row.totalSales,
      row.costProfit,
    ]);
    const escape = (value: unknown) => `"${String(value ?? "").replace(/"/g, '""')}"`;
    const csv = [headers, ...values].map((row) => row.map(escape).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `stock-in-sales-report-${format(new Date(), "yyyy-MM-dd")}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(link.href);
  };

  const profitTone = summary.costProfit > 0 ? "positive" : summary.costProfit < 0 ? "negative" : "default";

  return (
    <div className="container mx-auto space-y-5 p-0 sm:p-6">
      <PageHeader
        title="Stock In & Sales Report"
        onBack={() => (window.location.href = "/sales-report")}
        backButtonTestId="button-back-stock-in-sales"
        meta={<span>Stock and sales overview{selectedCompany?.name ? ` · ${selectedCompany.name}` : ""}</span>}
      >
        <Button variant="outline" size="sm" onClick={openComparison} data-testid="button-stock-in-sales-compare">
          <GitCompare className="mr-2 h-4 w-4" /> Compare
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="gap-2" disabled={rows.length === 0 || isExporting}>
              {isExporting ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />} Export
              <ChevronDown className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={exportExcel}>
              <FileSpreadsheet className="mr-2 h-4 w-4" /> Export Excel
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportCsv}>
              <FileText className="mr-2 h-4 w-4" /> Export CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => window.print()}>
              <FileText className="mr-2 h-4 w-4" /> Export PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          Array.from({ length: 6 }).map((_, index) => <Skeleton key={index} className="h-14 rounded-lg" />)
        ) : (
          <>
            <SummaryPill
              label="Opening Stock"
              value={formatNumber(summary.openingStockQty, 0)}
              icon={PackagePlus}
              testId="text-opening-stock-qty"
            />
            <SummaryPill
              label="Stock In"
              value={formatNumber(summary.stockInQty, 0)}
              icon={PackagePlus}
              testId="text-stock-in-qty"
            />
            <SummaryPill
              label="Stock in Hand"
              value={formatNumber(summary.closingStockQty, 0)}
              icon={PackageMinus}
              testId="text-stock-in-hand-qty"
            />
            <SummaryPill
              label="Stock Value"
              value={formatRoundedAmount(summary.closingStockValue)}
              icon={Coins}
              testId="text-stock-in-hand-value"
            />
            <SummaryPill
              label="Sales"
              value={formatRoundedAmount(summary.totalSales)}
              icon={TrendingUp}
              testId="text-stock-in-sales-total-sales"
            />
            <SummaryPill
              label="Gross Profit"
              value={formatSignedRoundedAmount(summary.costProfit)}
              icon={summary.costProfit < 0 ? TrendingDown : TrendingUp}
              tone={profitTone}
              testId="text-stock-in-sales-profit"
            />
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <PeriodFilter
          value={periodFilter}
          onChange={setPeriodFilter}
          data-testid="period-filter-stock-in-sales-report"
        />
        <MultiSelectFilter
          label="Locations"
          singularLabel="Location"
          items={sortedLocations}
          selectedIds={selectedLocations}
          onChange={setSelectedLocations}
          testId="button-stock-in-sales-location-filter"
        />
        <MultiSelectFilter
          label="Groups"
          singularLabel="Group"
          items={sortedStockGroups}
          selectedIds={selectedStockGroups}
          onChange={setSelectedStockGroups}
          testId="button-stock-in-sales-group-filter"
        />
        <Input
          placeholder="Search items..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
          className="h-9 w-48"
        />
        <Button variant="ghost" size="sm" onClick={clearFilters}>
          Clear
        </Button>
        {isFetching && !isLoading && (
          <RefreshCw className="h-4 w-4 animate-spin text-muted-foreground" aria-label="Refreshing" />
        )}
      </div>

      <div>
        <p className="mb-3 text-xs text-muted-foreground">
          {grouping === "daily"
            ? "Daily stock movement and profitability · Click a day for that day's full details"
            : grouping === "yearly"
              ? "Yearly stock movement and profitability · Click a year for full details"
              : "Monthly stock movement and profitability · Click a month for full details"}
        </p>
        <div className="overflow-hidden rounded-xl border">
          <div className="overflow-x-auto">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>{periodColumnLabel}</TableHead>
                  <TableHead className="text-right">Opening</TableHead>
                  <TableHead className="text-right">Stock In</TableHead>
                  <TableHead className="text-right">Stock Out</TableHead>
                  <TableHead className="text-right">Stock in Hand</TableHead>
                  <TableHead className="text-right">Stock Value</TableHead>
                  <TableHead className="text-right">Sales</TableHead>
                  <TableHead className="text-right">Gross Profit</TableHead>
                  <TableHead className="w-8" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  Array.from({ length: 6 }).map((_, index) => (
                    <TableRow key={index}>
                      {Array.from({ length: 9 }).map((__, cellIndex) => (
                        <TableCell key={cellIndex}>
                          <Skeleton className={`h-4 ${cellIndex === 0 ? "w-28" : "ml-auto w-20"}`} />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <div className="flex flex-col items-center gap-3 py-10 text-center">
                        <TrendingDown className="h-6 w-6 text-destructive" />
                        <p className="text-sm font-medium">Unable to load the report</p>
                        <p className="text-xs text-muted-foreground">{error?.message}</p>
                        <Button variant="outline" size="sm" onClick={() => refetch()}>
                          Retry
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                      No stock or sales activity found for these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {rows.map((row) => {
                      const profitClass =
                        row.costProfit > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : row.costProfit < 0
                            ? "text-red-600 dark:text-red-400"
                            : "text-muted-foreground";
                      return (
                        <TableRow
                          key={row.periodKey}
                          className="cursor-pointer hover:bg-muted/40"
                          onClick={() => openDetail(row)}
                        >
                          <TableCell className="py-3 font-medium">{formatPeriodLabel(row)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.openingStockQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.stockInQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono">{formatNumber(row.stockOutQty, 0)}</TableCell>
                          <TableCell className="text-right font-mono font-semibold">
                            {formatNumber(row.closingStockQty, 0)}
                          </TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(row.closingStockValue)}</TableCell>
                          <TableCell className="text-right font-mono">{formatAmount(row.totalSales)}</TableCell>
                          <TableCell className={`text-right font-mono font-semibold ${profitClass}`}>
                            {formatSignedAmount(row.costProfit)}
                          </TableCell>
                          <TableCell>
                            <ChevronRight className="h-4 w-4 text-muted-foreground" />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    <TableRow className="bg-muted/40 font-semibold hover:bg-muted/40">
                      <TableCell className="text-xs uppercase tracking-wide text-muted-foreground">Total</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(summary.openingStockQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(summary.stockInQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(summary.stockOutQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatNumber(summary.closingStockQty, 0)}</TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(summary.closingStockValue)}</TableCell>
                      <TableCell className="text-right font-mono">{formatAmount(summary.totalSales)}</TableCell>
                      <TableCell className="text-right font-mono">{formatSignedAmount(summary.costProfit)}</TableCell>
                      <TableCell />
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      <div className="hidden text-xs text-muted-foreground print:block">
        Generated {format(new Date(), "yyyy-MM-dd HH:mm")}
      </div>
    </div>
  );
}
