// Extracted from ./SalesReportLegacy.tsx: state, queries and handlers for SalesReport.
import { useState, useMemo, useEffect } from "react";
import { hasAnyOpenDialog } from "@/hooks/use-escape-back";
import { useQuery } from "@tanstack/react-query";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { getInitialSalesReportGroups, getInitialSalesReportPeriod } from "./salesReportInitialState";
import { useDateJump } from "@/hooks/use-date-jump";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { format, parseISO } from "date-fns";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import type { DailySummary, GroupingType, ProfitFilter, SalesCogsReconciliation } from "./salesreportlegacy/types";
import {
  EMPTY_SALES_REPORT_TOTALS,
  fetchSalesReportRows,
  fetchSalesReportSummary,
  type SalesReportSummaryResponse,
} from "@/lib/salesReportBandwidthClient";
import { useSalesReportDateKeyboard } from "./salesreportlegacy/useSalesReportDateKeyboard";
import { exportSalesReportExcel } from "./salesreportlegacy/exportExcel";
import { type SalesReportFilterControlsProps } from "./salesreportlegacy/SalesReportFilterControls";
import type { ApiListRow } from "@shared/apiTypes";

export function useSalesReportLegacyModel() {
  const { selectedCompany } = useCompany();
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(getInitialSalesReportPeriod);
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));

  useSalesReportDateKeyboard(setPeriodFilter);

  const [selectedLocations, setSelectedLocations] = useState<string[]>([]);
  const [selectedStockGroups, setSelectedStockGroups] = useState<string[]>(getInitialSalesReportGroups);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  const [grouping, setGrouping] = useState<GroupingType>("daily");
  const [profitFilter, setProfitFilter] = useState<ProfitFilter>("all");
  const [mergeView, setMergeView] = useState(false);
  const [isMultiCompanyMode, setIsMultiCompanyMode] = useState(false);
  const [selectedCompanies, setSelectedCompanies] = useState<string[]>([]);
  const [selectedRowDate, setSelectedRowDate] = useState<string | null>(null);
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearchTerm(searchTerm.trim()), 350);
    return () => window.clearTimeout(timer);
  }, [searchTerm]);

  // Fetch locations
  const { data: locations = [] } = useQuery<ApiListRow[]>({
    queryKey: ["/api/locations"],
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

  // Wave 4 heavy-read path: the interactive list requests only SQL-aggregated
  // summary rows. Raw sale lines are fetched only for explicit export/drill-down.
  const singleSummaryParams = new URLSearchParams();
  if (periodFilter.fromDate) singleSummaryParams.set("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) singleSummaryParams.set("endDate", periodFilter.toDate);
  singleSummaryParams.set("grouping", grouping);
  singleSummaryParams.set("mergeView", String(mergeView));
  singleSummaryParams.set("profitFilter", profitFilter);
  if (debouncedSearchTerm) singleSummaryParams.set("search", debouncedSearchTerm);
  if (selectedLocations.length > 0) singleSummaryParams.set("locationIds", selectedLocations.join(","));
  if (selectedStockGroups.length > 0) singleSummaryParams.set("stockGroupIds", selectedStockGroups.join(","));
  const singleSummaryUrl = `/api/sales-report/summary?${singleSummaryParams.toString()}`;

  const multiSummaryParams = new URLSearchParams();
  if (periodFilter.fromDate) multiSummaryParams.set("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) multiSummaryParams.set("endDate", periodFilter.toDate);
  multiSummaryParams.set("grouping", grouping);
  multiSummaryParams.set("mergeView", String(mergeView));
  multiSummaryParams.set("profitFilter", profitFilter);
  if (debouncedSearchTerm) multiSummaryParams.set("search", debouncedSearchTerm);
  if (selectedCompanies.length > 0) multiSummaryParams.set("companyFilter", selectedCompanies.join(","));
  if (selectedStockGroupNames.length > 0) {
    multiSummaryParams.set("stockGroupNames", JSON.stringify(selectedStockGroupNames));
  }
  const multiSummaryUrl = `/api/dashboard/sales-report-all/summary?${multiSummaryParams.toString()}`;

  const singleRawParams = new URLSearchParams();
  if (periodFilter.fromDate) singleRawParams.set("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) singleRawParams.set("endDate", periodFilter.toDate);
  const singleCompanyRawUrl = singleRawParams.toString()
    ? `/api/sales-report?${singleRawParams.toString()}`
    : "/api/sales-report";

  const multiRawParams = new URLSearchParams();
  if (periodFilter.fromDate) multiRawParams.set("startDate", periodFilter.fromDate);
  if (periodFilter.toDate) multiRawParams.set("endDate", periodFilter.toDate);
  if (selectedCompanies.length > 0) multiRawParams.set("companyFilter", selectedCompanies.join(","));
  if (selectedStockGroupNames.length > 0) multiRawParams.set("stockGroupName", selectedStockGroupNames[0]);
  const multiCompanyRawUrl = multiRawParams.toString()
    ? `/api/dashboard/sales-report-all?${multiRawParams.toString()}`
    : "/api/dashboard/sales-report-all";

  const {
    data: singleCompanySummary,
    isLoading: isLoadingSingle,
    isError: isErrorSingle,
    refetch: refetchSingle,
  } = useQuery<SalesReportSummaryResponse>({
    queryKey: [singleSummaryUrl],
    queryFn: () => fetchSalesReportSummary(singleSummaryUrl),
    enabled: !isMultiCompanyMode,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (previous) => previous,
  });

  const {
    data: allCompaniesSummary,
    isLoading: isLoadingMulti,
    isError: isErrorMulti,
    refetch: refetchMulti,
  } = useQuery<SalesReportSummaryResponse>({
    queryKey: [multiSummaryUrl],
    queryFn: () => fetchSalesReportSummary(multiSummaryUrl),
    enabled: isMultiCompanyMode,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    placeholderData: (previous) => previous,
  });

  const activeSummary = isMultiCompanyMode ? allCompaniesSummary : singleCompanySummary;
  const isLoading = isMultiCompanyMode ? isLoadingMulti : isLoadingSingle;
  const isError = isMultiCompanyMode ? isErrorMulti : isErrorSingle;
  const refetchReport = isMultiCompanyMode ? refetchMulti : refetchSingle;

  const filteredGroupedData = useMemo<DailySummary[]>(
    () =>
      (activeSummary?.groups ?? []).map((group) => ({
        ...group,
        displayDate:
          grouping === "daily"
            ? formatDisplayDate(parseISO(group.dateKey))
            : grouping === "monthly"
              ? format(parseISO(`${group.dateKey}-01`), "MMMM yyyy")
              : group.dateKey,
      })),
    [activeSummary?.groups, grouping, formatDisplayDate]
  );
  const groupedData = filteredGroupedData;
  const totals = activeSummary?.totals ?? EMPTY_SALES_REPORT_TOTALS;
  const companyFilterOptions = useMemo<[string, string][]>(
    () =>
      isMultiCompanyMode ? (allCompaniesSummary?.companies ?? []).map((company) => [company.code, company.name]) : [],
    [isMultiCompanyMode, allCompaniesSummary?.companies]
  );

  const isAllTimeReconciliationView =
    !isMultiCompanyMode &&
    !periodFilter.fromDate &&
    !periodFilter.toDate &&
    selectedLocations.length === 0 &&
    selectedStockGroups.length === 0 &&
    !searchTerm &&
    profitFilter === "all";

  const { data: cogsReconciliation } = useQuery<SalesCogsReconciliation>({
    queryKey: ["/api/sales-report/cogs-reconciliation"],
    enabled: isAllTimeReconciliationView,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const handleClearFilters = () => {
    setPeriodFilter(getDefaultPeriodValue("today"));
    setSelectedLocations([]);
    setSelectedStockGroups([]);
    setSearchTerm("");
    setProfitFilter("all");
    setSelectedCompanies([]);
  };

  // The primary Cost Profit KPI always equals recorded sales minus recorded COGS.
  // The separate inventory-based reconciliation is a diagnostic, not a replacement
  // for the booked profit (especially while historical source coverage is partial).
  const displayedCostProfit = totals.costProfit;

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
    if (selectedStockGroups.length === 1) {
      if (isMultiCompanyMode && selectedStockGroupNames.length === 1) {
        params.set("stockGroupName", selectedStockGroupNames[0]);
      } else {
        params.set("stockGroupId", selectedStockGroups[0]);
      }
    }
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

  const handleExportExcel = async () => {
    try {
      const salesData = await fetchSalesReportRows(isMultiCompanyMode ? multiCompanyRawUrl : singleCompanyRawUrl);
      await exportSalesReportExcel(salesData);
    } catch (error: unknown) {
      toast({
        title: "Export failed",
        description: error instanceof Error ? error.message : "The detailed sales rows could not be loaded.",
        variant: "destructive",
      });
    }
  };

  const handleExportPDF = () => {
    window.print();
  };

  return {
    selectedCompany,
    periodFilter,
    setPeriodFilter,
    selectedLocations,
    selectedStockGroups,
    searchTerm,
    setSearchTerm,
    grouping,
    profitFilter,
    isMultiCompanyMode,
    selectedRowDate,
    formatAmount,
    isLoading,
    isError,
    refetchReport,
    filteredGroupedData,
    groupedData,
    totals,
    isAllTimeReconciliationView,
    cogsReconciliation,
    handleClearFilters,
    displayedCostProfit,
    salesReportActiveFilterCount,
    salesReportFilterControls,
    handleRowClick,
    handleExportExcel,
    handleExportPDF,
  };
}

export type SalesReportLegacyModel = ReturnType<typeof useSalesReportLegacyModel>;
