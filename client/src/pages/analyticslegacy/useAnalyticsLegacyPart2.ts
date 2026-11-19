// Extracted from ./useAnalyticsLegacy.tsx to keep that module under the source-size cap.
import { useQuery } from "@tanstack/react-query";
import type { NetProfitStatementData } from "./types";
import {
  sanitizeNetProfitInventoryExpenses,
  withExpenseParents,
  type ExpensePeriodBreakdown,
  type ExpensePeriodResponse,
} from "./useAnalyticsLegacyWithExpenseParents";
import { useAnalyticsLegacyPart1 } from "./useAnalyticsLegacyPart1";
import { useAnalyticsLegacyPart4 } from "./useAnalyticsLegacyPart4";

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
  const {
    userCompanies,
    buildContainerUrl,
    containerData,
    loadingContainers,
    factoryOrderPage,
    setFactoryOrderPage,
    factoryOrderStatus,
    setFactoryOrderStatus,
    factoryOrderDestination,
    setFactoryOrderDestination,
    factoryOrderIncludeCharges,
    setFactoryOrderIncludeCharges,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    loadingFactoryCustomerOrders,
    factoryPosSummary,
    loadingFactoryPos,
    buildOpeningStockUrl,
    loadingOpeningStock,
    openingStockData,
    showingExpensePeriod,
  } = useAnalyticsLegacyPart4({
    activeSection,
    appMode,
    buildStockMovementUrl,
    containerPeriodFilter,
    openingStockLocationId,
    periodFilter,
    reportAllCompanies,
    reportContainerStatus,
    selectedCompany,
  });
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
