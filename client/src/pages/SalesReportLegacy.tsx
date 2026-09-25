import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo, useEffect } from "react";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import { PeriodFilter, PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { ErpMobileFilters } from "@/components/ui/erp-mobile-filters";
import { useDateJump } from "@/hooks/use-date-jump";

import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  FileSpreadsheet,
  FileText,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  ChevronDown,
  Download,
  GitCompare,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { format, parseISO, startOfDay, startOfMonth, startOfYear } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { formatNumber } from "@/lib/formatNumber";
import { ErrorState } from "@/components/ui/page-state";

import type { DailySummary, GroupingType, ProfitFilter, SalesReportItem } from "./salesreportlegacy/types";
import { useSalesReportDateKeyboard } from "./salesreportlegacy/useSalesReportDateKeyboard";
import { exportSalesReportExcel } from "./salesreportlegacy/exportExcel";
import {
  SalesReportFilterControls,
  type SalesReportFilterControlsProps,
} from "./salesreportlegacy/SalesReportFilterControls";
import type { ApiListRow } from "@shared/apiTypes";
export default function SalesReport() {
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("today"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  useSalesReportDateKeyboard(setPeriodFilter);

  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedStockGroups, setSelectedStockGroups] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [grouping, setGrouping] = useState<GroupingType>("daily");
  const [profitFilter, setProfitFilter] = useState<ProfitFilter>("all");
  const [mergeView, setMergeView] = useState(false);
  const [isMultiCompanyMode, setIsMultiCompanyMode] = useState(false);
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const [selectedRowDate, setSelectedRowDate] = useState<string | null>(null);
  const { toast: _toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();

  // Fetch locations
  const { data: locations = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/locations"],
  });

  // Fetch stock items (lightweight — only needs id/name/code for filter dropdown)
  const { data: stockItems = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/stock-items/light", selectedCompany?.id],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });

  // Fetch stock groups
  const { data: stockGroups = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/stock-groups"],
  });

  // Resolve selected group names (for multi-company query)
  const selectedStockGroupNames = useMemo(
    () => stockGroups.filter((g) => selectedStockGroups.includes(String(g.id))).map((g) => g.name as string),
    [stockGroups, selectedStockGroups]
  );

  // Build query params for single-company mode (location/group filtered client-side)
  const queryParams = new URLSearchParams();
  if (periodFilter.fromDate) queryParams.append("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) queryParams.append("endDate", periodFilter.toDate);

  const queryString = queryParams.toString();
  const singleCompanyQueryKey = queryString ? `/api/sales-report?${queryString}` : "/api/sales-report";

  // Build query params for multi-company mode
  const multiCompanyParams = new URLSearchParams();
  if (periodFilter.fromDate) multiCompanyParams.append("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) multiCompanyParams.append("endDate", periodFilter.toDate);
  // Note: locationId and stockItemId are company-specific so not passed in multi-company mode
  if (selectedCompanies.length > 0) multiCompanyParams.append("companyFilter", selectedCompanies.join(","));
  if (selectedStockGroupNames.length > 0) {
    multiCompanyParams.append("stockGroupName", selectedStockGroupNames[0]);
  }

  const multiCompanyQueryString = multiCompanyParams.toString();
  const multiCompanyQueryKey = multiCompanyQueryString
    ? `/api/dashboard/sales-report-all?${multiCompanyQueryString}`
    : "/api/dashboard/sales-report-all";

  // Fetch sales report data (single company)
  const {
    data: singleCompanySalesData = [],
    isLoading: isLoadingSingle,
    isError: isErrorSingle,
    refetch: refetchSingle,
  } = useQuery<SalesReportItem[]>({
    queryKey: [singleCompanyQueryKey],
    enabled: !isMultiCompanyMode,
  });

  // Fetch sales report data (all companies)
  const {
    data: allCompaniesSalesData = [],
    isLoading: isLoadingMulti,
    isError: isErrorMulti,
    refetch: refetchMulti,
  } = useQuery<SalesReportItem[]>({
    queryKey: [multiCompanyQueryKey],
    enabled: isMultiCompanyMode,
  });

  // Use the appropriate data based on mode
  const salesData = isMultiCompanyMode ? allCompaniesSalesData : singleCompanySalesData;
  const isLoading = isMultiCompanyMode ? isLoadingMulti : isLoadingSingle;
  const isError = isMultiCompanyMode ? isErrorMulti : isErrorSingle;
  const refetchReport = isMultiCompanyMode ? refetchMulti : refetchSingle;

  // Build set of stockItemIds that belong to selected groups (for client-side group filtering)
  const selectedGroupItemIds = useMemo(() => {
    if (selectedStockGroups.length === 0) return null;
    return new Set(
      stockItems
        .filter((item) => selectedStockGroups.includes(String(item.stockGroupId)))
        .map((item) => item.id as number)
    );
  }, [selectedStockGroups, stockItems]);

  // Apply location and group filters client-side
  const localFilteredData = useMemo(
    () =>
      salesData.filter((item) => {
        if (selectedLocations.length > 0 && !selectedLocations.includes(String(item.locationId))) return false;
        if (selectedGroupItemIds && !selectedGroupItemIds.has(item.stockItemId)) return false;
        return true;
      }),
    [salesData, selectedLocations, selectedGroupItemIds]
  );

  // Extract unique companies from multi-company data
  const companyFilterOptions = useMemo(() => {
    if (!isMultiCompanyMode || !allCompaniesSalesData.length) return [];
    const uniqueCompanies = new Map<string, string>();
    allCompaniesSalesData.forEach((item) => {
      if (item.companyCode && item.companyName) {
        uniqueCompanies.set(item.companyCode, item.companyName);
      }
    });
    return Array.from(uniqueCompanies.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [isMultiCompanyMode, allCompaniesSalesData]);

  // Group sales by date/month/year — credit sales get their own separate group
  const groupedData: DailySummary[] = localFilteredData.reduce((acc: DailySummary[], item) => {
    const itemDate = parseISO(item.voucherDate);
    let dateKey: string;
    let displayDate: string;

    if (grouping === "daily") {
      dateKey = format(startOfDay(itemDate), "yyyy-MM-dd");
      displayDate = formatDisplayDate(itemDate);
    } else if (grouping === "monthly") {
      dateKey = format(startOfMonth(itemDate), "yyyy-MM");
      displayDate = format(itemDate, "MMMM yyyy");
    } else {
      dateKey = format(startOfYear(itemDate), "yyyy");
      displayDate = format(itemDate, "yyyy");
    }

    const isCredit = item.isCreditSale === true;
    // In merge view combine credit + cash; otherwise keep them separate
    const groupKey = !mergeView && isCredit ? `${dateKey}-credit` : dateKey;

    // Filter by search term
    if (searchTerm && !searchAny(searchTerm, item.stockItemName, item.locationName)) {
      return acc;
    }

    const existing = acc.find((g) => g.date === groupKey);
    const totalSales = parseFloat(item.totalSales);
    const totalCost = parseFloat(item.totalCost);
    const totalConfiguredCost = item.totalConfiguredCost;
    const costProfit = parseFloat(item.costProfit);
    const configuredProfit = item.configuredProfit;

    const qty = parseFloat(item.quantity);

    if (existing) {
      existing.totalSales += totalSales;
      existing.totalCost += totalCost;
      existing.totalConfiguredCost += totalConfiguredCost;
      existing.costProfit += costProfit;
      existing.configuredProfit += configuredProfit;
      existing.itemCount += 1;
      existing.totalQty += qty;
      existing.items.push(item);
      // If we're merging and this row mixes credit + cash, flag it
      if (mergeView && existing.isCreditSale !== isCredit) {
        existing.hasMixedSales = true;
      }
    } else {
      acc.push({
        date: groupKey,
        dateKey,
        displayDate,
        totalSales,
        totalCost,
        totalConfiguredCost,
        costProfit,
        configuredProfit,
        itemCount: 1,
        totalQty: qty,
        isCreditSale: isCredit,
        hasMixedSales: false,
        items: [item],
      });
    }

    return acc;
  }, []);

  // Sort by date descending (most recent first)
  groupedData.sort((a, b) => b.date.localeCompare(a.date));

  // Apply profit filter — always based on cost profit (the real P&L metric)
  const filteredGroupedData = groupedData.filter((group) => {
    if (profitFilter === "all") return true;
    if (profitFilter === "positive") return group.costProfit >= 0;
    if (profitFilter === "negative") return group.costProfit < 0;
    return true;
  });

  // Calculate totals
  const totals = filteredGroupedData.reduce(
    (acc, group) => ({
      totalSales: acc.totalSales + group.totalSales,
      totalCost: acc.totalCost + group.totalCost,
      totalConfiguredCost: acc.totalConfiguredCost + group.totalConfiguredCost,
      costProfit: acc.costProfit + group.costProfit,
      configuredProfit: acc.configuredProfit + group.configuredProfit,
      totalQty: acc.totalQty + group.totalQty,
    }),
    { totalSales: 0, totalCost: 0, totalConfiguredCost: 0, costProfit: 0, configuredProfit: 0, totalQty: 0 }
  );

  const handleClearFilters = () => {
    setPeriodFilter(getDefaultPeriodValue("today"));
    setSelectedLocations([]);
    setSelectedStockGroups([]);
    setSearchTerm("");
    setProfitFilter("all");
    setSelectedCompanies([]);
  };

  // Declared after handleClearFilters: the build-time bandwidth transform
  // replaces the block that ends there. Counts what "Clear filters" resets;
  // grouping, merge and company scope are view options.
  const salesReportActiveFilterCount = [
    selectedCompanies.length > 0,
    selectedLocations.length > 0,
    selectedStockGroups.length > 0,
    profitFilter !== "all",
  ].filter(Boolean).length;

  const salesReportFilterControls: SalesReportFilterControlsProps = {
    periodFilter,
    setPeriodFilter,
    isMultiCompanyMode,
    setIsMultiCompanyMode,
    companyFilterOptions,
    selectedCompanies,
    setSelectedCompanies,
    grouping,
    setGrouping,
    profitFilter,
    setProfitFilter,
    mergeView,
    setMergeView,
    locations,
    selectedLocations,
    setSelectedLocations,
    stockGroups,
    selectedStockGroups,
    setSelectedStockGroups,
  };

  const [, navigate] = useLocation();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (hasAnyOpenDialog()) return;
        const tag = (document.activeElement?.tagName || "").toLowerCase();
        if (["input", "textarea", "select"].includes(tag)) return;
        if (filteredGroupedData.length === 0) return;
        e.preventDefault();
        setSelectedRowDate((prev) => {
          const idx = prev ? filteredGroupedData.findIndex((g) => g.date === prev) : -1;
          if (e.key === "ArrowDown") {
            return filteredGroupedData[idx < filteredGroupedData.length - 1 ? idx + 1 : 0].date;
          } else {
            return filteredGroupedData[idx > 0 ? idx - 1 : filteredGroupedData.length - 1].date;
          }
        });
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [filteredGroupedData]);

  useEffect(() => {
    if (!selectedRowDate) return;
    const el = document.querySelector(`[data-testid="row-sale-${selectedRowDate}"]`);
    if (el) el.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [selectedRowDate]);

  const handleRowClick = (summary: DailySummary) => {
    setSelectedRowDate(summary.date);
    const params = new URLSearchParams();
    params.set("displayDate", summary.displayDate);
    params.set("grouping", grouping);
    // Always use the clean dateKey (not the compound group key) for API date params
    const dk = summary.dateKey;
    if (grouping === "daily") {
      params.set("startDate", dk);
      params.set("endDate", dk);
    } else if (grouping === "monthly") {
      const [y, m] = dk.split("-").map(Number);
      const start = `${dk}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const end = `${dk}-${String(lastDay).padStart(2, "0")}`;
      params.set("startDate", start);
      params.set("endDate", end);
    } else {
      params.set("startDate", `${dk}-01-01`);
      params.set("endDate", `${dk}-12-31`);
    }
    if (selectedLocations.length === 1) params.set("locationId", selectedLocations[0]);
    if (selectedStockGroups.length === 1) params.set("stockGroupId", selectedStockGroups[0]);
    if (searchTerm) params.set("searchTerm", searchTerm);
    // Merged rows contain both credit and cash — omit the param so detail shows all
    if (!summary.hasMixedSales) {
      params.set("isCreditSale", summary.isCreditSale ? "true" : "false");
    }
    if (isMultiCompanyMode) {
      params.set("allCompanies", "true");
      if (selectedCompanies.length > 0) params.set("companyFilter", selectedCompanies.join(","));
    }
    window.open(`/sales-report/detail?${params.toString()}`, "_blank");
  };

  const handleExportExcel = () => exportSalesReportExcel(salesData);

  const handleExportPDF = () => {
    window.print();
  };

  return (
    <div className="container mx-auto space-y-6 p-0 sm:p-6">
      {/* Header */}
      <PageHeader
        title="Sales Report"
        subtitle="Analyze profit and loss from POS transactions"
        meta={isMultiCompanyMode ? <span>All Companies</span> : undefined}
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => navigate("/sales-report/comparison")}
          data-testid="button-compare-companies"
        >
          <GitCompare className="w-4 h-4 mr-2" />
          Compare
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              disabled={groupedData.length === 0}
              data-testid="button-export-dropdown"
            >
              <Download className="w-4 h-4" />
              Export
              <ChevronDown className="w-4 h-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={handleExportExcel} data-testid="menu-export-excel">
              <FileSpreadsheet className="w-4 h-4 mr-2" />
              Export Excel
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleExportPDF} data-testid="menu-export-pdf">
              <FileText className="w-4 h-4 mr-2" />
              Export PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>

      {/* Summary Pills */}
      <div className="flex flex-wrap gap-2">
        {isLoading ? (
          <>
            <Skeleton className="h-9 w-36 rounded-lg" />
            <Skeleton className="h-9 w-36 rounded-lg" />
            <Skeleton className="h-9 w-40 rounded-lg" />
            <Skeleton className="h-9 w-40 rounded-lg" />
            <Skeleton className="h-9 w-44 rounded-lg" />
          </>
        ) : (
          <>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
              <span className="text-muted-foreground text-xs">Total Sales</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-total-sales">
                {formatAmount(totals.totalSales)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground text-xs">Cost Price</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-total-cost">
                {formatAmount(totals.totalCost)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              {totals.costProfit >= 0 ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-500" />
              )}
              <span className="text-muted-foreground text-xs">Cost Profit</span>
              <span
                className={`font-semibold font-mono text-sm ${totals.costProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                data-testid="text-cost-profit"
              >
                {totals.costProfit < 0 ? "-" : ""}
                {formatAmount(Math.abs(totals.costProfit))}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              <span className="text-muted-foreground text-xs">Hassan's Price</span>
              <span className="font-semibold font-mono text-sm" data-testid="text-configured-cost">
                {formatAmount(totals.totalConfiguredCost)}
              </span>
            </div>
            <div className="flex items-center gap-1.5 rounded-lg border bg-muted/40 px-3 py-1.5 text-sm">
              {totals.configuredProfit >= 0 ? (
                <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
              ) : (
                <TrendingDown className="h-3.5 w-3.5 text-red-500" />
              )}
              <span className="text-muted-foreground text-xs">Hassan's Profit</span>
              <span
                className={`font-semibold font-mono text-sm ${totals.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                data-testid="text-configured-profit"
              >
                {totals.configuredProfit < 0 ? "-" : ""}
                {formatAmount(Math.abs(totals.configuredProfit))}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Unified filter bar (phones: period + search + Filters sheet) */}
      <ErpMobileFilters
        label="Sales report filters"
        primary={
          <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter-sales-report" />
        }
        quick={
          <Input
            placeholder="Search..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full"
            data-testid="input-search"
          />
        }
        activeCount={salesReportActiveFilterCount}
        onClear={handleClearFilters}
        canClear={salesReportActiveFilterCount > 0 || !!searchTerm}
        data-testid="sales-report-filters"
      >
        {(layout) =>
          layout === "sheet" ? (
            <div className="grid gap-3">
              <SalesReportFilterControls {...salesReportFilterControls} />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              {/* Date period */}
              <PeriodFilter value={periodFilter} onChange={setPeriodFilter} data-testid="period-filter-sales-report" />

              <SalesReportFilterControls {...salesReportFilterControls} showSeparator />

              {/* Search */}
              <Input
                placeholder="Search..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-40 h-9"
                data-testid="input-search"
              />

              {/* Clear — only when filters are active */}
              {(searchTerm ||
                selectedLocations.length > 0 ||
                selectedStockGroups.length > 0 ||
                profitFilter !== "all") && (
                <Button variant="ghost" size="sm" onClick={handleClearFilters} data-testid="button-clear-filters">
                  Clear
                </Button>
              )}
            </div>
          )
        }
      </ErpMobileFilters>

      {/* Data Table */}
      <div>
        <p className="text-xs text-muted-foreground mb-3">
          Sales by {grouping.charAt(0).toUpperCase() + grouping.slice(1)}
          {filteredGroupedData.length > 0 &&
            ` · ${filteredGroupedData.length} row${filteredGroupedData.length !== 1 ? "s" : ""}`}
          {" · "}Click any row to drill in
        </p>
        <div className="border rounded-xl overflow-hidden max-sm:overflow-visible max-sm:border-0">
          <div className="overflow-x-auto">
            <Table mobileLayout="cards">
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead className="text-xs h-9 font-semibold">Date</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">Items</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right">Qty</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right">Total Sales</TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Cost Price
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Cost Profit
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Hassan's Price
                  </TableHead>
                  <TableHead className="text-xs h-9 font-semibold text-right hidden sm:table-cell">
                    Hassan's Profit
                  </TableHead>
                  <TableHead className="text-xs h-9 w-8"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading ? (
                  [...Array(6)].map((_, i) => (
                    <TableRow key={i}>
                      <TableCell>
                        <Skeleton className="h-4 w-24" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-8 ml-auto" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-10 ml-auto" />
                      </TableCell>
                      <TableCell>
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-16 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-20 ml-auto" />
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        <Skeleton className="h-4 w-16 ml-auto" />
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  ))
                ) : isError ? (
                  <TableRow>
                    <TableCell colSpan={8}>
                      <ErrorState
                        title="Sales report unavailable"
                        description="The sales data could not be loaded for this period."
                        actionLabel="Retry report"
                        onAction={() => void refetchReport()}
                      />
                    </TableCell>
                  </TableRow>
                ) : filteredGroupedData.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9}>
                      <div className="flex flex-col items-center gap-2 py-10 text-center">
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center">
                          <TrendingUp className="h-5 w-5 text-muted-foreground" />
                        </div>
                        <p className="text-sm font-medium">No sales found</p>
                        <p className="text-xs text-muted-foreground">Try adjusting your date range or filters</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  <>
                    {filteredGroupedData.map((group) => (
                      <TableRow
                        key={group.date}
                        data-testid={`row-sale-${group.date}`}
                        className={`cursor-pointer hover:bg-muted/40${selectedRowDate === group.date ? " bg-muted/40" : ""}`}
                        onClick={() => handleRowClick(group)}
                      >
                        <TableCell className="font-medium py-3">
                          <div className="flex items-center gap-2">
                            {group.displayDate}
                            {group.hasMixedSales ? (
                              <Badge
                                variant="secondary"
                                className="text-xs no-default-active-elevate bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                              >
                                Credit + Cash
                              </Badge>
                            ) : group.isCreditSale ? (
                              <Badge
                                variant="secondary"
                                className="text-xs no-default-active-elevate bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                              >
                                Credit
                              </Badge>
                            ) : null}
                          </div>
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                          {formatNumber(group.itemCount, 0)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm">
                          {formatNumber(group.totalQty, 0)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm">
                          {formatAmount(group.totalSales)}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                          {formatAmount(group.totalCost)}
                        </TableCell>
                        <TableCell
                          className={`py-3 text-right font-mono text-sm font-semibold hidden sm:table-cell ${group.costProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                        >
                          {group.costProfit < 0 ? "-" : ""}
                          {formatAmount(Math.abs(group.costProfit))}
                        </TableCell>
                        <TableCell className="py-3 text-right font-mono text-sm text-muted-foreground hidden sm:table-cell">
                          {formatAmount(group.totalConfiguredCost)}
                        </TableCell>
                        <TableCell
                          className={`py-3 text-right font-mono text-sm font-semibold hidden sm:table-cell ${group.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                        >
                          {group.configuredProfit < 0 ? "-" : ""}
                          {formatAmount(Math.abs(group.configuredProfit))}
                        </TableCell>
                        <TableCell className="py-3">
                          <ChevronRight className="h-4 w-4 text-muted-foreground" />
                        </TableCell>
                      </TableRow>
                    ))}
                    {/* Totals Row */}
                    <TableRow className="bg-muted/40 hover:bg-muted/40 font-semibold">
                      <TableCell className="py-3 text-xs uppercase tracking-wide text-muted-foreground">
                        Total
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {formatNumber(localFilteredData.length, 0)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm">
                        {formatNumber(totals.totalQty, 0)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm">
                        {formatAmount(totals.totalSales)}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {formatAmount(totals.totalCost)}
                      </TableCell>
                      <TableCell
                        className={`py-3 text-right font-mono text-sm hidden sm:table-cell ${totals.costProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                      >
                        {totals.costProfit < 0 ? "-" : ""}
                        {formatAmount(Math.abs(totals.costProfit))}
                      </TableCell>
                      <TableCell className="py-3 text-right font-mono text-sm hidden sm:table-cell">
                        {formatAmount(totals.totalConfiguredCost)}
                      </TableCell>
                      <TableCell
                        className={`py-3 text-right font-mono text-sm hidden sm:table-cell ${totals.configuredProfit >= 0 ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400"}`}
                      >
                        {totals.configuredProfit < 0 ? "-" : ""}
                        {formatAmount(Math.abs(totals.configuredProfit))}
                      </TableCell>
                      <TableCell></TableCell>
                    </TableRow>
                  </>
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      </div>

      {/* Print Styles */}
      <style>{`
        @media print {
          body * {
            visibility: hidden;
          }
          .container * {
            visibility: visible;
          }
          .container {
            position: absolute;
            left: 0;
            top: 0;
            width: 100%;
          }
          button {
            display: none !important;
          }
        }
      `}</style>
    </div>
  );
}
