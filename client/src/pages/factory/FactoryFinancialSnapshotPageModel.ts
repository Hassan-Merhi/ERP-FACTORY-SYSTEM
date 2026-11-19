// Extracted from ./FactoryFinancialSnapshot.tsx: state, queries and handlers for FactoryFinancialSnapshot.
import { useLocation } from "wouter";
import { useFactoryFinancialSnapshotModel } from "./factoryfinancialsnapshot/useFactoryFinancialSnapshotModel";

export function useFactoryFinancialSnapshotPageModel() {
  const [, navigate] = useLocation();
  const financialSnapshot = useFactoryFinancialSnapshotModel();
  const {
    addAccountMutation,
    canChangeExistingRecords,
    advanceExpanded,
    agentExpanded,
    cardLabel,
    cashBankExpanded,
    computed,
    customerExpanded,
    freightExpanded,
    handleRefresh,
    isFetching,
    isLoading,
    lastUpdated,
    loadingSnapshot,
    netPosition,
    pickerAccounts,
    pickerFor,
    pickerSearch,
    removeAccountMutation,
    setAdvanceExpanded,
    setAgentExpanded,
    setCashBankExpanded,
    setCustomerExpanded,
    setFreightExpanded,
    setPickerFor,
    setPickerSearch,
    setSupplierExpanded,
    snapshot,
    supplierExpanded,
  } = financialSnapshot;
  const allLoading = isLoading || !computed;

  return {
    navigate,
    addAccountMutation,
    canChangeExistingRecords,
    advanceExpanded,
    agentExpanded,
    cardLabel,
    cashBankExpanded,
    computed,
    customerExpanded,
    freightExpanded,
    handleRefresh,
    isFetching,
    isLoading,
    lastUpdated,
    loadingSnapshot,
    netPosition,
    pickerAccounts,
    pickerFor,
    pickerSearch,
    removeAccountMutation,
    setAdvanceExpanded,
    setAgentExpanded,
    setCashBankExpanded,
    setCustomerExpanded,
    setFreightExpanded,
    setPickerFor,
    setPickerSearch,
    setSupplierExpanded,
    snapshot,
    supplierExpanded,
    allLoading,
  };
}

export type FactoryFinancialSnapshotPageModel = ReturnType<typeof useFactoryFinancialSnapshotPageModel>;
