// Extracted from ./StockInSalesReport.tsx: state, queries and handlers for StockInSalesReportSummary.
import { exportFileName } from "@/lib/exportFile";
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format, parseISO, differenceInCalendarDays } from "date-fns";
import { erpReportFileName, exportErpReportCsv } from "@/erp-core";
import { erpCompanyDataKey, erpReferenceKeys } from "@/erp-core/erpData";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useToast } from "@/hooks/use-toast";
import { useLocation } from "wouter";

export function useStockInSalesReportSummaryModel() {
  const [, navigate] = useLocation();
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
    queryKey: erpReferenceKeys.locations(selectedCompany?.id),
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });

  const { data: stockGroups = [] } = useQuery<StockGroupOption[]>({
    queryKey: erpReferenceKeys.stockGroups(selectedCompany?.id),
    enabled: !!selectedCompany?.id,
    staleTime: 5 * 60 * 1000,
  });

  const sortedLocations = useMemo(() => [...locations].sort((a, b) => a.name.localeCompare(b.name)), [locations]);
  const sortedStockGroups = useMemo(() => [...stockGroups].sort((a, b) => a.name.localeCompare(b.name)), [stockGroups]);
  const grouping = useMemo(() => resolveGrouping(periodFilter), [periodFilter]);
  const periodColumnLabel: "Day" | "Year" | "Month" =
    grouping === "daily" ? "Day" : grouping === "yearly" ? "Year" : "Month";

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
    queryKey: erpCompanyDataKey(queryUrl, selectedCompany?.id),
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

  const stockInSalesActiveFilterCount = [selectedLocations.length > 0, selectedStockGroups.length > 0].filter(
    Boolean
  ).length;

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
      const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
      const exportRows = rows.map((row) => ({
        period: formatPeriodLabel(row),
        openingStockQty: row.openingStockQty,
        stockInQty: row.stockInQty,
        stockOutQty: row.stockOutQty,
        closingStockQty: row.closingStockQty,
        closingStockValue: row.closingStockValue,
        totalSales: row.totalSales,
        costProfit: row.costProfit,
      }));
      await exportOperationalWorkbook({
        title: "Stock & Sales Report",
        fileName: erpReportFileName("stock-in-sales-report", "xlsx", new Date(), "-"),
        companyName: selectedCompany?.name,
        currencyCode: "USD",
        filters: [
          { label: "Period", value: periodFilter.fromDate + " — " + periodFilter.toDate },
          { label: "Locations", value: selectedLocations.join(",") || "All" },
          { label: "Groups", value: selectedStockGroups.join(",") || "All" },
          { label: "Search", value: debouncedSearch || "All" },
        ],
        sheets: [
          {
            name: "Stock & Sales Report",
            columns: [
              { key: "period", header: periodColumnLabel, width: 22 },
              { key: "openingStockQty", header: "Opening Qty", type: "decimal", width: 16 },
              { key: "stockInQty", header: "Stock In", type: "decimal", width: 16 },
              { key: "stockOutQty", header: "Stock Out", type: "decimal", width: 16 },
              { key: "closingStockQty", header: "Closing Qty", type: "decimal", width: 16 },
              { key: "closingStockValue", header: "Closing Value", type: "money", width: 18 },
              { key: "totalSales", header: "Sales", type: "money", width: 18 },
              { key: "costProfit", header: "Gross Profit", type: "money", width: 18 },
            ],
            rows: exportRows,
          },
        ],
      });
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
    exportErpReportCsv({
      headers,
      rows: values,
      fileName: exportFileName("stock in sales report", "csv", {
        from: periodFilter.fromDate,
        to: periodFilter.toDate,
      }),
    });
  };

  const profitTone: "positive" | "negative" | "default" =
    summary.costProfit > 0 ? "positive" : summary.costProfit < 0 ? "negative" : "default";

  return {
    navigate,
    selectedCompany,
    formatAmount,
    periodFilter,
    setPeriodFilter,
    selectedLocations,
    setSelectedLocations,
    selectedStockGroups,
    setSelectedStockGroups,
    searchTerm,
    setSearchTerm,
    isExporting,
    sortedLocations,
    sortedStockGroups,
    grouping,
    periodColumnLabel,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    summary,
    rows,
    formatSignedAmount,
    formatRoundedAmount,
    formatSignedRoundedAmount,
    formatPeriodLabel,
    stockInSalesActiveFilterCount,
    clearFilters,
    openDetail,
    openComparison,
    exportExcel,
    exportCsv,
    profitTone,
  };
}

export type StockInSalesReportSummaryModel = ReturnType<typeof useStockInSalesReportSummaryModel>;

export interface LocationOption {
  id: number;
  name: string;
}

export interface StockGroupOption {
  id: number;
  name: string;
}

export interface StockInSalesMetrics {
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

export interface StockInSalesRow extends StockInSalesMetrics {
  periodKey: string;
  periodStart: string;
  periodEnd: string;
}

export interface StockInSalesResponse {
  generatedAt: string;
  summary: StockInSalesMetrics;
  rows: StockInSalesRow[];
  rowCount: number;
}

export type ReportGrouping = "daily" | "monthly" | "yearly";

export function resolveGrouping(period: PeriodFilterValue): ReportGrouping {
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

export const EMPTY_METRICS: StockInSalesMetrics = {
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
