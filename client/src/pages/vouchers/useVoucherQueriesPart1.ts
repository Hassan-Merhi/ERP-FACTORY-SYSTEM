// Extracted from ./useVoucherQueries.ts
import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { stockItemKeys } from "@/lib/queryKeys";
import type {
  BankAccount,
  LedgerAccount,
  Supplier,
  Customer,
  Employee,
  FactorySupplierBasic,
  StockItem,
  Location,
} from "./voucherTypes";

export interface UseVoucherQueriesProps {
  selectedCompany: { id: number; companyType?: string } | null;
  isFactoryCompany: boolean;
  isPropertiesCompany: boolean;
  voucherIdToEdit: number | null;
  accountPickersNeeded: boolean;
  activeTab: string;
  isPOS: boolean;
  posLocationId?: number | null;
}

export function useVoucherQueriesPart1({
  selectedCompany,
  isFactoryCompany,
  isPropertiesCompany,
  voucherIdToEdit,
  accountPickersNeeded,
  activeTab,
  isPOS,
  posLocationId,
}: Pick<
  UseVoucherQueriesProps,
  | "selectedCompany"
  | "isFactoryCompany"
  | "isPropertiesCompany"
  | "voucherIdToEdit"
  | "accountPickersNeeded"
  | "activeTab"
  | "isPOS"
  | "posLocationId"
>) {
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
    queryKey: [
      `/api/ledger-accounts?profile=voucher-picker&includeHidden=true&companyId=${selectedCompany?.id}`,
      selectedCompany?.id,
    ],
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
  return {
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
  };
}
