import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { erpCompanyDataKey } from "@/erp-core/erpData";
import { useToast } from "@/hooks/use-toast";
import { getTopProfitCompanyByItem, groupMarketRows } from "./itemMarketAnalysisGrouping";
import { fetchSalePriceExportRows } from "./itemMarketAnalysisSalePrices";
import { getDefaultPeriodValue, type PeriodFilterValue } from "@/components/ui/period-filter";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import {
  normalizeItemCode,
  matchesProfitDirection,
  type MarketResponse,
  type ProfitDirectionFilter,
} from "./itemMarketAnalysisParts";
import { valueMarketRow } from "./itemMarketAnalysisValuation";

export function useItemMarketAnalysisModel() {
  const { selectedCompany, companies } = useCompany();
  const { formatAmount } = useCurrencyContext();
  const { toast } = useToast();
  const [isExporting, setIsExporting] = useState(false);
  const [period, setPeriod] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("all_time"));
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedStockGroupNames, setSelectedStockGroupNames] = useState<string[]>([]);
  const [stockGroupPopoverOpen, setStockGroupPopoverOpen] = useState(false);
  const [profitDirection, setProfitDirection] = useState<ProfitDirectionFilter>("all");
  const [selectedCompanyIds, setSelectedCompanyIds] = useState<number[]>([]);
  const [companyPopoverOpen, setCompanyPopoverOpen] = useState(false);
  const [expandedItemCode, setExpandedItemCode] = useState<string | null>(null);
  const [expandedSalePriceKey, setExpandedSalePriceKey] = useState<string | null>(null);
  const [visibleRowCount, setVisibleRowCount] = useState(250);
  const [includeOffloadingCost, setIncludeOffloadingCost] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    setSelectedStockGroupNames([]);
    setProfitDirection("all");
    setExpandedItemCode(null);
    setExpandedSalePriceKey(null);
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
    setExpandedItemCode(null);
    setExpandedSalePriceKey(null);
  };

  const toggleStockGroup = (groupName: string) => {
    setSelectedStockGroupNames((current) =>
      current.includes(groupName) ? current.filter((name) => name !== groupName) : [...current, groupName]
    );
    setExpandedItemCode(null);
    setExpandedSalePriceKey(null);
  };

  const queryUrl = useMemo(() => {
    const params = new URLSearchParams();
    if (period.fromDate) params.set("startDate", period.fromDate);
    if (period.toDate) params.set("endDate", period.toDate);
    if (debouncedSearch) params.set("search", debouncedSearch);
    if (selectedStockGroupNames.length > 0) params.set("stockGroupNames", selectedStockGroupNames.join(","));
    if (selectedCompanyIds.length > 0) params.set("companyIds", selectedCompanyIds.join(","));
    return `/api/reports/item-market-analysis?${params.toString()}`;
  }, [period, debouncedSearch, selectedStockGroupNames, selectedCompanyIds]);

  const { data, isLoading, isFetching, isError, error, refetch } = useQuery<MarketResponse, Error>({
    queryKey: erpCompanyDataKey(queryUrl, selectedCompany?.id, selectedCompanyIds),
    enabled: selectedCompany?.companyType === "erp" && selectedCompanyIds.length > 0,
    staleTime: 5 * 60_000,
    gcTime: 15 * 60_000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    setVisibleRowCount(250);
    setExpandedItemCode(null);
    setExpandedSalePriceKey(null);
  }, [queryUrl, profitDirection, multiCompany, includeOffloadingCost]);

  // Sales Report's all-time KPI uses a company-wide stock/COGS reconciliation,
  // not the modeled per-item purchase cost. Only compare unfiltered views.
  const comparableToSalesReport =
    selectedCompanyIds.length === 1 &&
    selectedCompanyIds[0] === selectedCompany?.id &&
    !period.fromDate &&
    !period.toDate &&
    !debouncedSearch &&
    selectedStockGroupNames.length === 0 &&
    profitDirection === "all";
  const { data: salesReportReconciliation } = useQuery<{
    totalSales: number;
    adjustedCostProfit: number;
  }>({
    queryKey: erpCompanyDataKey("/api/sales-report/cogs-reconciliation", selectedCompany?.id),
    enabled: comparableToSalesReport,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  const rawRows = useMemo(() => data?.rows ?? [], [data?.rows]);
  const stockGroups = data?.stockGroups ?? [];

  const baseRows = useMemo(
    () =>
      rawRows
        .map((row) => valueMarketRow(row, includeOffloadingCost))
        .sort(
          (left, right) =>
            normalizeItemCode(left.code).localeCompare(normalizeItemCode(right.code)) ||
            left.companyName.localeCompare(right.companyName)
        ),
    [rawRows, includeOffloadingCost]
  );

  // In multi-company mode, filter by the combined profit for the item code so
  // expanding a kept item still shows every selected company's contribution.
  const combinedProfitByItemKey = useMemo(() => {
    const combined = new Map<string, number>();
    if (multiCompany && profitDirection !== "all") {
      for (const row of baseRows) {
        const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
        combined.set(itemKey, (combined.get(itemKey) ?? 0) + row.profit);
      }
    }
    return combined;
  }, [baseRows, multiCompany, profitDirection]);

  const rows = useMemo(
    () =>
      baseRows.filter((row) => {
        if (profitDirection === "all") return true;
        if (!multiCompany) return matchesProfitDirection(row.profit, profitDirection);
        const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
        return matchesProfitDirection(combinedProfitByItemKey.get(itemKey) ?? 0, profitDirection);
      }),
    [baseRows, combinedProfitByItemKey, multiCompany, profitDirection]
  );

  const summary = useMemo(() => {
    const totals = rows.reduce(
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
      itemCount: new Set(rows.map((row) => normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`))
        .size,
      ...totals,
      marginPct: totals.revenue === 0 ? 0 : (totals.profit / totals.revenue) * 100,
    };
  }, [rows]);

  const selectedCompanyNames = useMemo(
    () => erpCompanies.filter((company) => selectedCompanyIds.includes(company.id)),
    [erpCompanies, selectedCompanyIds]
  );

  const companySummaries = useMemo(
    () =>
      selectedCompanyNames.map((company) => {
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
      }),
    [rows, selectedCompanyNames]
  );

  const topProfitCompanyByItem = useMemo(() => getTopProfitCompanyByItem(rows), [rows]);

  const groupedRows = useMemo(() => groupMarketRows(rows), [rows]);

  const handleExportExcel = async () => {
    if (!data || isFetching || isExporting || search.trim() !== debouncedSearch) return;
    setIsExporting(true);
    try {
      const salePriceRows = await fetchSalePriceExportRows(rows, {
        startDate: period.fromDate,
        endDate: period.toDate,
      });

      const { exportItemMarketAnalysisExcel } = await import("./itemMarketAnalysisExport");
      await exportItemMarketAnalysisExcel({
        groups: groupedRows,
        rows,
        companySummaries,
        summary,
        salePriceRows,
        startDate: period.fromDate,
        endDate: period.toDate,
        search: debouncedSearch,
        stockGroups: selectedStockGroupNames,
        companyNames: selectedCompanyNames.map((company) => company.name),
        profitDirection,
        includeOffloadingCost,
        generatedAt: data.generatedAt,
      });
      toast({
        title: "Excel exported",
        description: `Exported ${groupedRows.length} items and ${rows.length} company-item records with current filters.`,
      });
    } catch (error) {
      toast({
        title: "Excel export failed",
        description: error instanceof Error ? error.message : "Could not generate the workbook.",
        variant: "destructive",
      });
    } finally {
      setIsExporting(false);
    }
  };

  const visibleRows = rows.slice(0, visibleRowCount);
  const visibleGroupedRows = groupedRows.slice(0, visibleRowCount);
  const totalVisibleSourceRows = multiCompany ? groupedRows.length : rows.length;

  return {
    selectedCompany,
    formatAmount,
    isExporting,
    period,
    setPeriod,
    search,
    setSearch,
    debouncedSearch,
    selectedStockGroupNames,
    setSelectedStockGroupNames,
    stockGroupPopoverOpen,
    setStockGroupPopoverOpen,
    profitDirection,
    setProfitDirection,
    selectedCompanyIds,
    companyPopoverOpen,
    setCompanyPopoverOpen,
    expandedItemCode,
    setExpandedItemCode,
    expandedSalePriceKey,
    setExpandedSalePriceKey,
    visibleRowCount,
    setVisibleRowCount,
    includeOffloadingCost,
    setIncludeOffloadingCost,
    erpCompanies,
    multiCompany,
    toggleCompany,
    toggleStockGroup,
    data,
    isLoading,
    isFetching,
    isError,
    error,
    refetch,
    comparableToSalesReport,
    salesReportReconciliation,
    stockGroups,
    rows,
    summary,
    selectedCompanyNames,
    companySummaries,
    topProfitCompanyByItem,
    groupedRows,
    handleExportExcel,
    visibleRows,
    visibleGroupedRows,
    totalVisibleSourceRows,
  };
}

export type ItemMarketAnalysisModel = ReturnType<typeof useItemMarketAnalysisModel>;
