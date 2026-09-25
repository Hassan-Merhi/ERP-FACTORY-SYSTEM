import { useAnalyticsFactoryQueries } from "./useAnalyticsFactoryQueries";
import { useAnalyticsReferenceQueries } from "./useAnalyticsReferenceQueries";
import { useAnalyticsReportQueries } from "./useAnalyticsReportQueries";

type DateRange = Record<string, string>;

interface UseAnalyticsQueriesProps {
  selectedCompanyId?: number;
  activeSection: string;
  balStartDate: string;
  balEndDate: string;
  dateRange: DateRange;
  selectedLocationForDetails: number | null;
  detailsDateRange: DateRange;
  buildContainerUrl: () => string;
  appMode: string;
  buildFactorySalesUrl: (base: string) => string;
  buildFactoryContainerSalesUrl: () => string;
  plStartDate: string;
  plEndDate: string;
  buildStockMovementUrl: () => string;
  openingStockLocationId: string;
}

export function useAnalyticsQueries({
  selectedCompanyId,
  activeSection,
  balStartDate,
  balEndDate,
  dateRange,
  selectedLocationForDetails,
  detailsDateRange,
  buildContainerUrl,
  appMode,
  buildFactorySalesUrl,
  buildFactoryContainerSalesUrl,
  plStartDate,
  plEndDate,
  buildStockMovementUrl,
  openingStockLocationId,
}: UseAnalyticsQueriesProps) {
  const referenceQueries = useAnalyticsReferenceQueries({
    selectedCompanyId,
    activeSection,
  });

  const reportQueries = useAnalyticsReportQueries({
    selectedCompanyId,
    activeSection,
    appMode,
    balStartDate,
    balEndDate,
    dateRange,
    selectedLocationForDetails,
    detailsDateRange,
    containerUrl: buildContainerUrl(),
    plStartDate,
    plEndDate,
    stockMovementUrl: buildStockMovementUrl(),
    openingStockLocationId,
  });

  const factorySalesUrl = buildFactorySalesUrl("");
  const factoryQueries = useAnalyticsFactoryQueries({
    selectedCompanyId,
    appMode,
    factorySalesUrl,
    factorySalesByCustomerUrl: buildFactorySalesUrl("/api/factory/analytics/sales-by-customer"),
    factoryPosSummaryUrl: buildFactorySalesUrl("/api/factory/analytics/pos-summary"),
    factoryContainerSalesUrl: buildFactoryContainerSalesUrl(),
  });

  return {
    ...referenceQueries,
    ...reportQueries,
    ...factoryQueries,
  };
}
