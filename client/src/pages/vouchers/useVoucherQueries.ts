const PAY_FROM_LEDGER_TYPES = new Set(["Cash", "Bank", "Loans"]);

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Supplier, Customer, FixedAsset } from "./voucherTypes";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import type { Account } from "@/components/AccountSidebar";
import { useVoucherQueriesPart1, type UseVoucherQueriesProps } from "./useVoucherQueriesPart1";

export function useVoucherQueries({
  selectedCompany,
  isFactoryCompany,
  isPropertiesCompany,
  voucherIdToEdit,
  accountPickersNeeded,
  activeTab,
  isPOS,
  posLocationId,
}: UseVoucherQueriesProps) {
  const {
    liveAccountSearch,
    setLiveAccountSearch,
    debouncedAccountSearch,
    loadVoucherAccountData,
    needsStockData,
    bankAccounts,
    bankAccountsFetched,
    bankAccountsError,
    refetchBankAccounts,
    ledgerAccounts,
    ledgerAccountsFetched,
    ledgerAccountsError,
    refetchLedgerAccounts,
    suppliers,
    suppliersFetched,
    factorySuppliersList,
    customers,
    customersFetched,
    stockItems,
    locations,
    posLocation,
    posLocationName,
    myLocations,
    employees,
  } = useVoucherQueriesPart1({
    selectedCompany,
    isFactoryCompany,
    isPropertiesCompany,
    voucherIdToEdit,
    accountPickersNeeded,
    activeTab,
    isPOS,
    posLocationId,
  });

  const { data: fixedAssets = [] } = useQuery<FixedAsset[]>({
    queryKey: ["/api/fixed-assets", selectedCompany?.id],
    enabled: loadVoucherAccountData && !!selectedCompany?.id,
  });

  const { data: supplierSearchResults = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", "live-search", debouncedAccountSearch, selectedCompany?.id],
    enabled: loadVoucherAccountData && debouncedAccountSearch.length >= 2 && !!selectedCompany && !isPropertiesCompany,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const res = await fetch(`/api/suppliers?search=${encodeURIComponent(debouncedAccountSearch)}&limit=50`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to search suppliers");
      return res.json();
    },
  });

  const { data: customerSearchResults = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers", "live-search", debouncedAccountSearch, selectedCompany?.id],
    enabled: loadVoucherAccountData && debouncedAccountSearch.length >= 2 && !!selectedCompany,
    staleTime: 30 * 1000,
    queryFn: async () => {
      const res = await fetch(`/api/customers?search=${encodeURIComponent(debouncedAccountSearch)}&limit=50`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to search customers");
      return res.json();
    },
  });

  const {
    data: sidebarAccounts = [],
    isError: sidebarAccountsError,
    refetch: refetchSidebarAccounts,
  } = useQuery<Account[]>({
    queryKey: ["/api/accounts/voucher-sidebar", selectedCompany?.id],
    enabled: loadVoucherAccountData && !!selectedCompany?.id,
  });

  const { data: voucherToEdit, isLoading: loadingVoucher } = useQuery({
    queryKey: ["/api/vouchers", voucherIdToEdit],
    enabled: loadVoucherAccountData && !!voucherIdToEdit,
    queryFn: async () => {
      const res = await fetch(`/api/vouchers/${voucherIdToEdit}`);
      if (!res.ok) throw new Error("Failed to fetch voucher");
      return res.json();
    },
  });

  // Pay From / Receive Into field: only Cash, Bank, and Loans ledger accounts + all bank accounts
  const payFromAccounts = useMemo<CombinedAccount[]>(
    () =>
      [
        ...ledgerAccounts
          .filter((a) => PAY_FROM_LEDGER_TYPES.has(a.accountType))
          .map((a) => ({ type: "ledger" as const, id: a.id, name: a.name, code: a.code })),
        ...bankAccounts.map((a) => ({ type: "bank" as const, id: a.id, name: a.bankName, code: a.accountNumber })),
      ].sort((a, b) => (a.name || "").localeCompare(b.name || "")),
    [ledgerAccounts, bankAccounts]
  );

  const allAccounts = useMemo<CombinedAccount[]>(() => {
    const accounts = [
      ...ledgerAccounts.map((a) => ({ type: "ledger" as const, id: a.id, name: a.name, code: a.code })),
      ...bankAccounts.map((a) => ({ type: "bank" as const, id: a.id, name: a.bankName, code: a.accountNumber })),
      ...suppliers.map((s) => ({ type: "supplier" as const, id: s.id, name: s.legalName, code: s.code })),
      ...supplierSearchResults
        .filter((s) => !suppliers.find((p) => p.id === s.id))
        .map((s) => ({ type: "supplier" as const, id: s.id, name: s.legalName, code: s.code })),
      ...employees.map((e) => ({
        type: "employee" as const,
        id: e.id,
        name: `${e.firstName} ${e.lastName}`,
        code: e.code,
        openingBalance: e.openingBalance,
      })),
      ...fixedAssets.map((f) => ({
        type: "fixedAsset" as const,
        id: f.id,
        name: f.name,
        code: f.code,
        openingBalance: f.openingBalance,
      })),
      ...customers.map((c: Customer) => ({
        type: "customer" as const,
        id: c.id,
        name: c.legalName,
        code: c.code,
        openingBalance: c.openingBalance,
      })),
      ...customerSearchResults
        .filter((c) => !customers.find((p) => p.id === c.id))
        .map((c: Customer) => ({
          type: "customer" as const,
          id: c.id,
          name: c.legalName,
          code: c.code,
          openingBalance: c.openingBalance,
        })),
      ...factorySuppliersList.map((s) => ({
        type: "factorySupplier" as const,
        id: s.id,
        name: s.name,
        code: String(s.id),
      })),
    ];
    return accounts.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [
    ledgerAccounts,
    bankAccounts,
    suppliers,
    supplierSearchResults,
    employees,
    fixedAssets,
    customers,
    customerSearchResults,
    factorySuppliersList,
  ]);

  return {
    bankAccounts,
    bankAccountsFetched,
    bankAccountsError,
    refetchBankAccounts,
    ledgerAccounts,
    ledgerAccountsFetched,
    ledgerAccountsError,
    refetchLedgerAccounts,
    suppliers,
    suppliersFetched,
    customers,
    customersFetched,
    employees,
    fixedAssets,
    factorySuppliersList,
    stockItems,
    locations,
    posLocation,
    posLocationName,
    myLocations,
    sidebarAccounts,
    sidebarAccountsError,
    refetchSidebarAccounts,
    voucherToEdit,
    loadingVoucher,
    supplierSearchResults,
    customerSearchResults,
    allAccounts,
    payFromAccounts,
    needsStockData,
    liveAccountSearch,
    setLiveAccountSearch,
  };
}
