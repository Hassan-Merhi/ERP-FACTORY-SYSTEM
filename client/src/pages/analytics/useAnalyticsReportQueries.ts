import { useQuery } from "@tanstack/react-query";
import { analyticsKeys } from "@/lib/queryKeys";
import type {
  Account,
  ContainerData,
  LocationSales,
  NetProfitStatementData,
  OpeningStockSummaryData,
  POSTransaction,
  StockMovementData,
} from "./analyticsTypes";
import {
  fetchAnalyticsAccounts,
  fetchAnalyticsArray,
  fetchAnalyticsJson,
} from "./analyticsQueryClient";

type DateRange = Record<string, string>;

interface UseAnalyticsReportQueriesProps {
  selectedCompanyId?: number;
  activeSection: string;
  balStartDate: string;
  balEndDate: string;
  dateRange: DateRange;
  selectedLocationForDetails: number | null;
  detailsDateRange: DateRange;
  containerUrl: string;
  plStartDate: string;
  plEndDate: string;
  stockMovementUrl: string;
  openingStockLocationId: string;
}

export function useAnalyticsReportQueries({
  selectedCompanyId,
  activeSection,
  balStartDate,
  balEndDate,
  dateRange,
  selectedLocationForDetails,
  detailsDateRange,
  containerUrl,
  plStartDate,
  plEndDate,
  stockMovementUrl,
  openingStockLocationId,
}: UseAnalyticsReportQueriesProps) {
  const accountsQuery = useQuery<Account[]>({
    queryKey: analyticsKeys.accounts(selectedCompanyId, balStartDate, balEndDate),
    queryFn: () => {
      const params = new URLSearchParams({ profile: "analytics" });
      if (balStartDate) params.append("startDate", balStartDate);
      if (balEndDate) params.append("endDate", balEndDate);
      const url = `/api/accounts/all?${params.toString()}`;
      return fetchAnalyticsAccounts<Account>(url);
    },
    enabled: !!selectedCompanyId,
  });

  const salesDataQuery = useQuery<LocationSales[]>({
    queryKey: analyticsKeys.financialSales(selectedCompanyId, dateRange),
    queryFn: () =>
      fetchAnalyticsArray<LocationSales>(
        `/api/financial/sales?${new URLSearchParams(dateRange)}`,
        "Failed to fetch sales data",
      ),
    enabled: !!selectedCompanyId,
  });

  const transactionsQuery = useQuery<POSTransaction[]>({
    queryKey: analyticsKeys.financialTransactions(selectedLocationForDetails, detailsDateRange),
    queryFn: () =>
      fetchAnalyticsArray<POSTransaction>(
        `/api/financial/sales/${selectedLocationForDetails}/transactions?${new URLSearchParams(detailsDateRange)}`,
        "Failed to fetch transactions",
      ),
    enabled: !!selectedLocationForDetails,
  });

  const containerDataQuery = useQuery<ContainerData>({
    queryKey: analyticsKeys.urlScoped(containerUrl, selectedCompanyId),
    queryFn: () => fetchAnalyticsJson<ContainerData>(containerUrl, "Failed to fetch containers"),
    enabled: !!selectedCompanyId,
  });

  const netProfitDataQuery = useQuery<NetProfitStatementData>({
    queryKey: analyticsKeys.netProfitStatement(selectedCompanyId, plStartDate, plEndDate),
    queryFn: () => {
      const params = new URLSearchParams();
      if (plStartDate) params.append("startDate", plStartDate);
      if (plEndDate) params.append("endDate", plEndDate);
      const url = `/api/reports/net-profit-statement${params.toString() ? `?${params.toString()}` : ""}`;
      return fetchAnalyticsJson<NetProfitStatementData>(url, "Failed to fetch net profit statement");
    },
    enabled: !!selectedCompanyId,
  });

  const stockMovementDataQuery = useQuery<StockMovementData>({
    queryKey: analyticsKeys.urlScoped(stockMovementUrl, selectedCompanyId),
    queryFn: () => fetchAnalyticsJson<StockMovementData>(stockMovementUrl, "Failed to fetch stock movement"),
    enabled: !!selectedCompanyId && activeSection === "stock",
  });

  const openingStockDataQuery = useQuery<OpeningStockSummaryData>({
    queryKey: analyticsKeys.openingStockSummary(selectedCompanyId, openingStockLocationId),
    queryFn: () => {
      const url = `/api/reports/opening-stock-summary${
        openingStockLocationId !== "all" ? `?locationId=${openingStockLocationId}` : ""
      }`;
      return fetchAnalyticsJson<OpeningStockSummaryData>(url, "Failed to fetch opening stock summary");
    },
    enabled: !!selectedCompanyId && activeSection === "opening-stock",
  });

  return {
    accounts: accountsQuery.data || [],
    accountsLoading: accountsQuery.isLoading,
    salesData: salesDataQuery.data || [],
    salesLoading: salesDataQuery.isLoading,
    transactions: transactionsQuery.data || [],
    transactionsLoading: transactionsQuery.isLoading,
    containerData: containerDataQuery.data,
    loadingContainers: containerDataQuery.isLoading,
    netProfitData: netProfitDataQuery.data,
    loadingNetProfit: netProfitDataQuery.isLoading,
    stockMovementData: stockMovementDataQuery.data,
    loadingStock: stockMovementDataQuery.isLoading,
    openingStockData: openingStockDataQuery.data,
    loadingOpeningStock: openingStockDataQuery.isLoading,
  };
}
