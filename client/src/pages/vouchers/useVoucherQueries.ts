const PAY_FROM_LEDGER_TYPES = new Set(["Cash", "Bank", "Loans"]);

import { useState, useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { stockItemKeys } from "@/lib/queryKeys";
import type {
  BankAccount,
  LedgerAccount,
  Supplier,
  Customer,
  Employee,
  FixedAsset,
  FactorySupplierBasic,
  StockItem,
  Location,
} from "./voucherTypes";
import type { CombinedAccount } from "@/components/AccountAutocomplete";
import type { Account } from "@/components/AccountSidebar";

interface UseVoucherQueriesProps {
  selectedCompany: { id: number; companyType?: string } | null;
  isFactoryCompany: boolean;
  isPropertiesCompany: boolean;
  voucherIdToEdit: number | null;
  accountPickersNeeded: boolean;
  activeTab: string;
  isPOS: boolean;
  posLocationId?: number | null;
}

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
  const queryClient = useQueryClient();
  const [liveAccountSearch, setLiveAccountSearch] = useState("");
  const [debouncedAccountSearch, setDebouncedAccountSearch] = useState("");

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedAccountSearch(liveAccountSearch), 300);
    return () => clearTimeout(timer);
  }, [liveAccountSearch]);

  const isNormalStockTransfer = activeTab === "transfer";
  const isStockTransferEditor = isNormalStockTransfer || activeTab === "transferorder";
  const loadVoucherAccountData = !isNormalStockTransfer;

  // Both transfer editors reuse the same detail keys. Always refresh those two small
  // records when entering/switching transfer views so a just-saved narration, rows,
  // date, destination, or optional flag can never be replaced by an old React Query
  // snapshot. This also repairs the old global refetchOnMount:false behaviour for
  // these editor transitions without broad cache churn elsewhere in Vouchers.
  useEffect(() => {
    if (!isStockTransferEditor || !voucherIdToEdit) return;
    void queryClient.invalidateQueries({
      queryKey: ["/api/stock-transfers", voucherIdToEdit],
      exact: true,
      refetchType: "active",
    });
    void queryClient.invalidateQueries({
      queryKey: ["/api/vouchers", voucherIdToEdit],
      exact: true,
      refetchType: "active",
    });
  }, [activeTab, isStockTransferEditor, queryClient, voucherIdToEdit]);

  // Normal Stock Transfer owns its own lightweight stock/location queries inside
  // StockTransferForm. Do not fetch a second copy in the Vouchers shell.
  const needsStockData = isPOS || activeTab === "transferorder" || activeTab === "adjustment";

  const {
    data: bankAccounts = [],
    isFetched: bankAccountsFetched,
    isError: bankAccountsError,
    refetch: refetchBankAccounts,
  } = useQuery<BankAccount[]>({
    queryKey: ["/api/bank-accounts", selectedCompany?.id],
    enabled: loadVoucherAccountData && !!selectedCompany?.id,
  });

  const {
    data: ledgerAccounts = [],
    isFetched: ledgerAccountsFetched,
    isError: ledgerAccountsError,
    refetch: refetchLedgerAccounts,
  } = useQuery<LedgerAccount[]>({
    // includeHidden=true so cash / loan / bank accounts marked isHidden still appear in voucher pickers.
    // companyId is embedded in the URL so the server uses the explicit company rather than relying
    // on the session (which may not have updated yet on a company switch).
    queryKey: [`/api/ledger-accounts?includeHidden=true&companyId=${selectedCompany?.id}`, selectedCompany?.id],
    enabled: loadVoucherAccountData && !!selectedCompany?.id,
  });

  const { data: suppliers = [], isFetched: suppliersFetched } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", selectedCompany?.id],
    enabled: loadVoucherAccountData && accountPickersNeeded && !!selectedCompany && !isPropertiesCompany,
    staleTime: 5 * 60 * 1000,
  });

  const { data: factorySuppliersList = [] } = useQuery<FactorySupplierBasic[]>({
    queryKey: ["/api/factory/suppliers", selectedCompany?.id],
    enabled: loadVoucherAccountData && isFactoryCompany,
  });

  const { data: customers = [], isFetched: customersFetched } = useQuery<Customer[]>({
    queryKey: ["/api/customers", selectedCompany?.id],
    enabled: loadVoucherAccountData && accountPickersNeeded && !!selectedCompany,
    staleTime: 5 * 60 * 1000,
  });

  // Voucher transfer/adjustment/POS pickers only use id, code, name and uom.
  // Use the explicit identity profile and keep it warm across voucher screens;
  // unrelated voucher/proforma writes no longer evict this reference cache.
  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: stockItemKeys.identity(selectedCompany?.id),
    enabled: needsStockData && !!selectedCompany?.id,
    staleTime: 30 * 60 * 1000,
    gcTime: 2 * 60 * 60 * 1000,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations", selectedCompany?.id],
    enabled: needsStockData,
  });

  const posLocation = isPOS && posLocationId ? locations.find((l) => l.id === posLocationId) : null;
  const posLocationName = posLocation?.name || "";

  const { data: myLocations = [] } = useQuery<{ id: number; name: string }[]>({
    queryKey: ["/api/my-locations"],
    enabled: isPOS,
  });

  const { data: employees = [] } = useQuery<Employee[]>({
    queryKey: ["/api/employees", selectedCompany?.id],
    enabled: loadVoucherAccountData && !!selectedCompany?.id,
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
