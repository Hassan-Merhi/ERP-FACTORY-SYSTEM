// Extracted from ./SalesSectionPanel.tsx to keep that module under the source-size cap.
import { useState } from "react";
import type { AnalyticsLegacyState } from "../useAnalyticsLegacy";
import type { PosAnalyticsCustomer } from "./PosCustomerSalesDialog";

export function useSalesSectionPanelState({ analytics }: { analytics: AnalyticsLegacyState }) {
  const {
    activeSection,
    appMode,
    periodFilter,
    detailsPeriod,
    factoryPosSummary,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderPage,
    factoryOrderStatus,
    factoryOrderDestination,
    factoryOrderIncludeCharges,
    formatAmount,
    formatDisplayDate,
    loadingFactoryPos,
    loadingFactoryCustomerOrders,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    setDetailsPeriod,
    setFactoryOrderPage,
    setFactoryOrderStatus,
    setFactoryOrderDestination,
    setFactoryOrderIncludeCharges,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    transactions,
    transactionsLoading,
    navigate,
  } = analytics;
  const [expandedOrderCustomers, setExpandedOrderCustomers] = useState<Set<string>>(new Set());
  const [selectedPosCustomer, setSelectedPosCustomer] = useState<PosAnalyticsCustomer | null>(null);

  const toggleOrderCustomer = (key: string) => {
    setExpandedOrderCustomers((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };
  return {
    activeSection,
    appMode,
    detailsPeriod,
    expandedOrderCustomers,
    factoryCustomerOrderAnalytics,
    factoryCustomerOrderAnalyticsError,
    factoryOrderDestination,
    factoryOrderIncludeCharges,
    factoryOrderPage,
    factoryOrderStatus,
    factoryPosSummary,
    formatAmount,
    formatDisplayDate,
    loadingFactoryCustomerOrders,
    loadingFactoryPos,
    navigate,
    periodFilter,
    rangeEnd,
    rangeStart,
    salesData,
    salesLoading,
    selectedLocationForDetails,
    selectedPeriod,
    selectedPosCustomer,
    setDetailsPeriod,
    setFactoryOrderDestination,
    setFactoryOrderIncludeCharges,
    setFactoryOrderPage,
    setFactoryOrderStatus,
    setRangeEnd,
    setRangeStart,
    setSelectedLocationForDetails,
    setSelectedPeriod,
    setSelectedPosCustomer,
    toggleOrderCustomer,
    transactions,
    transactionsLoading,
  };
}
