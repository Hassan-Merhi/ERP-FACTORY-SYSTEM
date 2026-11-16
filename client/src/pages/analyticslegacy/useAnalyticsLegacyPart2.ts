// Extracted from ./useAnalyticsLegacy.tsx to keep that module under the source-size cap.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type {
  ContainerData,
  FactoryCustomerOrderAnalytics,
  FactoryPosSummary,
  NetProfitStatementData,
  OpeningStockSummaryData,
  StockMovementData,
} from "./types";
import {
  sanitizeNetProfitInventoryExpenses,
  withExpenseParents,
  type ExpensePeriodBreakdown,
  type ExpensePeriodResponse,
} from "./useAnalyticsLegacyWithExpenseParents";
import { useAnalyticsLegacyPart1 } from "./useAnalyticsLegacyPart1";

export function useAnalyticsLegacyPart2({
  accounts,
  activeSection,
  appMode,
  buildStockMovementUrl,
  containerPeriodFilter,
  expandedNetProfitSections,
  expandedStockGroups,
  openingStockLocationId,
  periodFilter,
  plEndDate,
  plStartDate,
  reportAllCompanies,
  reportContainerStatus,
  selectedCompany,
  setExpandedNetProfitSections,
  setExpandedStockGroups,
  setStockGroupItems,
  stockGroupItems,
}: Pick<
  Awaited<ReturnType<typeof useAnalyticsLegacyPart1>>,
  | "accounts"
  | "activeSection"
  | "appMode"
  | "buildStockMovementUrl"
  | "containerPeriodFilter"
  | "expandedNetProfitSections"
  | "expandedStockGroups"
  | "openingStockLocationId"
  | "periodFilter"
  | "plEndDate"
  | "plStartDate"
  | "reportAllCompanies"
  | "reportContainerStatus"
  | "selectedCompany"
  | "setExpandedNetProfitSections"
  | "setExpandedStockGroups"
  | "setStockGroupItems"
  | "stockGroupItems"
>) {
  useQuery<StockMovementData>({
    queryKey: [buildStockMovementUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch stock movement");
      return response.json();
    },
    enabled: true,
  });

  // Fetch user's accessible companies for the Container Report company filter
  const { data: userCompanies = [] } = useQuery<{ companyId: number; companyName: string }[]>({
    queryKey: ["/api/user/companies"],
    queryFn: async () => {
      const res = await fetch("/api/user/companies", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
  });

  // Fetch container report
  const buildContainerUrl = () => {
    const params = new URLSearchParams();
    if (containerPeriodFilter.fromDate) params.append("startDate", containerPeriodFilter.fromDate);
    if (containerPeriodFilter.toDate) params.append("endDate", containerPeriodFilter.toDate);
    // supplier filtering is done client-side so multi-select works without extra API params
    // Status is always set (Offloaded or OTW)
    params.append("status", reportContainerStatus);
    if (reportAllCompanies === "all") {
      params.append("allCompanies", "true");
    } else {
      params.append("specificCompanyId", reportAllCompanies);
    }
    return `/api/reports/containers?${params}`;
  };

  const { data: containerData, isLoading: loadingContainers } = useQuery<ContainerData>({
    queryKey: [buildContainerUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch containers");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // ── Factory Analytics Queries ───────────────────────────────────────────
  const [factoryOrderPage, setFactoryOrderPage] = useState(1);
  const [factoryOrderStatus, setFactoryOrderStatus] = useState("VERIFIED_FINALIZED");
  const [factoryOrderDestination, setFactoryOrderDestination] = useState("all");
  const [factoryOrderIncludeCharges, setFactoryOrderIncludeCharges] = useState(false);

  // The page-level PeriodFilter is the single date control for factory sales analytics.
  // Reset pagination whenever the selected period changes so a narrower range never
  // leaves the table stranded on a page that no longer exists.
  useEffect(() => {
    setFactoryOrderPage(1);
  }, [periodFilter.fromDate, periodFilter.toDate]);

  // A different company, period or status can have entirely different destinations.
  useEffect(() => {
    setFactoryOrderDestination("all");
  }, [selectedCompany?.id, periodFilter.fromDate, periodFilter.toDate, factoryOrderStatus]);

  const buildFactorySalesUrl = (base: string) => {
    const params = new URLSearchParams();
    if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);
    if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);
    const qs = params.toString();
    return qs ? `${base}?${qs}` : base;
  };

  const buildFactoryOrderAnalyticsUrl = () => {
    const params = new URLSearchParams();
    if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);
    if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);
    params.append("status", factoryOrderStatus);
    if (factoryOrderDestination !== "all") params.append("destinationExact", factoryOrderDestination);
    params.append("includeCharges", String(factoryOrderIncludeCharges));
    params.append("page", String(factoryOrderPage));
    params.append("pageSize", "50");
    return `/api/factory/analytics/customer-orders?${params.toString()}`;
  };

  const {
    data: factoryCustomerOrderAnalytics,
    isLoading: loadingFactoryCustomerOrders,
    isError: factoryCustomerOrderAnalyticsError,
  } = useQuery<FactoryCustomerOrderAnalytics>({
    queryKey: [
      "/api/factory/analytics/customer-orders",
      selectedCompany?.id,
      periodFilter.fromDate,
      periodFilter.toDate,
      factoryOrderStatus,
      factoryOrderDestination,
      factoryOrderIncludeCharges,
      factoryOrderPage,
    ],
    queryFn: async () => {
      const res = await fetch(buildFactoryOrderAnalyticsUrl(), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch customer order analytics");
      return res.json();
    },
    enabled: !!selectedCompany && appMode === "factory" && activeSection === "sales",
    retry: 1,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const { data: factoryPosSummary, isLoading: loadingFactoryPos } = useQuery<FactoryPosSummary>({
    queryKey: ["/api/factory/analytics/pos-summary", selectedCompany?.id, periodFilter.fromDate, periodFilter.toDate],
    queryFn: async () => {
      const res = await fetch(buildFactorySalesUrl("/api/factory/analytics/pos-summary"), { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch factory POS summary");
      return res.json();
    },
    enabled: !!selectedCompany && appMode === "factory" && activeSection === "sales",
  });

  // Fetch Opening Stock Summary
  const buildOpeningStockUrl = () => {
    const params = new URLSearchParams();
    if (openingStockLocationId && openingStockLocationId !== "all") {
      params.append("locationId", openingStockLocationId);
    }
    return `/api/reports/opening-stock-summary?${params}`;
  };

  const { data: openingStockData, isLoading: loadingOpeningStock } = useQuery<OpeningStockSummaryData>({
    queryKey: [buildOpeningStockUrl(), selectedCompany?.id],
    queryFn: async ({ queryKey }) => {
      const response = await fetch(queryKey[0] as string, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch opening stock summary");
      return response.json();
    },
    enabled: !!selectedCompany,
  });

  // Expense cards are period activity, not as-of closing ledger balances.
  // Their dedicated drill-downs also stay pinned to the Factory company.
  const showingExpensePeriod = ["expenses", "direct-expenses", "indirect-expenses"].includes(activeSection);
  const {
    data: rawPeriodExpenses,
    isLoading: loadingPeriodExpenses,
    isError: periodExpensesError,
  } = useQuery<ExpensePeriodResponse>({
    queryKey: ["analytics-period-expenses", appMode, selectedCompany?.id, plStartDate, plEndDate],
    queryFn: async () => {
      const base = appMode === "factory" ? "/api/factory/analytics" : "/api/reports/net-profit-statement";
      const params = new URLSearchParams();
      if (plStartDate) params.set("startDate", plStartDate);
      if (plEndDate) params.set("endDate", plEndDate);
      const suffix = params.toString() ? `?${params}` : "";
      const [directResponse, indirectResponse] = await Promise.all([
        fetch(`${base}/direct-expenses${suffix}`, { credentials: "include" }),
        fetch(`${base}/indirect-expenses${suffix}`, { credentials: "include" }),
      ]);
      if (!directResponse.ok || !indirectResponse.ok) {
        throw new Error("Could not load expenses for the selected period");
      }
      return {
        direct: (await directResponse.json()) as ExpensePeriodBreakdown,
        indirect: (await indirectResponse.json()) as ExpensePeriodBreakdown,
      };
    },
    enabled: !!selectedCompany && showingExpensePeriod,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  const periodExpenses = rawPeriodExpenses
    ? {
        direct: withExpenseParents(rawPeriodExpenses.direct, accounts),
        indirect: withExpenseParents(rawPeriodExpenses.indirect, accounts),
      }
    : undefined;

  // Fetch Net Profit Statement
  const { data: netProfitData, isLoading: loadingNetProfit } = useQuery<NetProfitStatementData>({
    queryKey: ["/api/reports/net-profit-statement", selectedCompany?.id, plStartDate, plEndDate],
    queryFn: async ({ queryKey }) => {
      const [base, , startDate, endDate] = queryKey as [string, unknown, string, string];
      const params = new URLSearchParams();
      if (startDate) params.append("startDate", startDate);
      if (endDate) params.append("endDate", endDate);
      const url = `${base}${params.toString() ? `?${params.toString()}` : ""}`;
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch net profit statement");
      const data = (await response.json()) as NetProfitStatementData;
      return sanitizeNetProfitInventoryExpenses(data);
    },
    enabled: !!selectedCompany,
  });

  // Toggle Net Profit section expansion
  const toggleNetProfitSection = (section: string) => {
    const newExpanded = new Set(expandedNetProfitSections);
    if (newExpanded.has(section)) {
      newExpanded.delete(section);
    } else {
      newExpanded.add(section);
    }
    setExpandedNetProfitSections(newExpanded);
  };

  // Toggle stock group expansion and fetch items
  const toggleStockGroup = async (groupId: number) => {
    const newExpanded = new Set(expandedStockGroups);
    if (newExpanded.has(groupId)) {
      newExpanded.delete(groupId);
    } else {
      newExpanded.add(groupId);
      // Fetch items if not already loaded
      if (!stockGroupItems.has(groupId)) {
        try {
          const params = new URLSearchParams();
          if (openingStockLocationId && openingStockLocationId !== "all") {
            params.append("locationId", openingStockLocationId);
          }
          const response = await fetch(`/api/reports/opening-stock-summary/${groupId}/items?${params}`, {
            credentials: "include",
          });
          if (response.ok) {
            const data = await response.json();
            setStockGroupItems(new Map(stockGroupItems).set(groupId, data));
          }
        } catch (error) {
          console.error("Failed to fetch stock group items:", error);
        }
      }
    }
    setExpandedStockGroups(newExpanded);
  };
  return {
    buildContainerUrl,
    buildOpeningStockUrl,
    containerData,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderDestination,
    factoryOrderIncludeCharges,
    factoryOrderPage,
    factoryOrderStatus,
    factoryPosSummary,
    loadingContainers,
    loadingFactoryCustomerOrders,
    loadingFactoryPos,
    loadingNetProfit,
    loadingOpeningStock,
    loadingPeriodExpenses,
    netProfitData,
    openingStockData,
    periodExpenses,
    periodExpensesError,
    setFactoryOrderDestination,
    setFactoryOrderIncludeCharges,
    setFactoryOrderPage,
    setFactoryOrderStatus,
    toggleNetProfitSection,
    toggleStockGroup,
    userCompanies,
  };
}
