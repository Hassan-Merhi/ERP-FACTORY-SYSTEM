// Extracted from ./useAccountsLegacyModel.ts: account, bank and WhatsApp-rule dialog state and mutations.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useForm } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { erpPageAccessQueryOptions } from "@/app/erpAccessQuery";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useDateJump } from "@/hooks/use-date-jump";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useDebounce } from "@/hooks/use-debounce";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { LedgerAccount, BankAccount, insertBankAccountSchema, updateLedgerAccountSchema } from "@shared/schema";
import type { InsertBankAccount, UpdateLedgerAccount } from "@shared/schema";
import { Account } from "../accounts/accountTypes";
import { type VoucherSearchResult } from "./useAccountsLegacyModelConstants";

export function useAccountsLegacyDialogsModel() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateBankAccount = recordChanges.canCreate("POST", "/api/bank-accounts");
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount, formatHistoricalBaseAmount, isMultiCurrency } = useCurrencyContext();

  // Account-list and statement balances are historical base values. They must
  // not change when the user changes the current display-rate preference.
  function formatAmountForAccount(amount: number, _accountType?: string): string {
    return formatHistoricalBaseAmount(amount);
  }
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({
    ...erpPageAccessQueryOptions(selectedCompany?.id, true),
  });
  const hideBalances = (myErpPages?.hiddenErpCostFields ?? []).includes("accounts_balances");
  const appMode = useAppMode();
  const accountsListUrl: "/api/factory/accounts/list" | "/api/accounts/all" =
    appMode === "factory" ? "/api/factory/accounts/list" : "/api/accounts/all";
  const modePrefix = useModePrefix();
  const modeApiRequest = getApiRequest(appMode);
  const [, navigate] = useLocation();
  const searchString = useSearch();

  const urlParams = new URLSearchParams(searchString);
  const urlAccountId = urlParams.get("accountId");
  const urlAccountType = urlParams.get("accountType");
  const urlStartDate = urlParams.get("startDate") || "";
  const urlEndDate = urlParams.get("endDate") || "";

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const fromExternalNavRef = useRef(false);

  useEscapeBack(
    selectedAccount
      ? () => {
          fromExternalNavRef.current = false;
          setSelectedAccount(null);
          updateUrlParams({ accountId: null, accountType: null, startDate: null, endDate: null });
        }
      : null
  );

  // Query key includes selectedCompany?.id and periodFilter.toDate so React Query refetches
  // when company or selected end date changes, keeping list balance in sync with statement.

  const [searchTerm, setSearchTerm] = useState("");
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => {
    if (urlStartDate || urlEndDate) {
      return { fromDate: urlStartDate, toDate: urlEndDate, preset: "custom" as const };
    }
    return getDefaultPeriodValue("all_time");
  });

  const [accountToEdit, setAccountToEdit] = useState<LedgerAccount | null>(null);
  const [supplierToEdit, setSupplierToEdit] = useState<Account | null>(null);
  const [customerToEdit, setCustomerToEdit] = useState<Account | null>(null);
  const [employeeToEdit, setEmployeeToEdit] = useState<Account | null>(null);
  const [bankToEdit, setBankToEdit] = useState<BankAccount | null>(null);
  const [pendingDelete, setPendingDelete] = useState<(() => void) | null>(null);
  const [alterSelectedAccount, setAlterSelectedAccount] = useState<Account | null>(null);
  const [findQuery, setFindQuery] = useState("");
  const debouncedFindQuery = useDebounce(findQuery, 350);

  const updateUrlParams = useCallback((updates: Record<string, string | null>) => {
    const params = new URLSearchParams(window.location.search);
    Object.entries(updates).forEach(([key, value]) => {
      if (value) params.set(key, value);
      else params.delete(key);
    });
    const newSearch = params.toString();
    window.history.replaceState(
      null,
      "",
      newSearch ? `${window.location.pathname}?${newSearch}` : window.location.pathname
    );
  }, []);

  useDateJump((date) => {
    const jumped = { fromDate: date, toDate: date, preset: "custom" as const };
    setPeriodFilter(jumped);
    updateUrlParams({ startDate: date, endDate: date });
  });

  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set());
  const [selectedVoucherIds, setSelectedVoucherIds] = useState<Set<number>>(new Set());
  const [showBulkDeleteConfirm, setShowBulkDeleteConfirm] = useState(false);
  const [showDeletedVouchers, setShowDeletedVouchers] = useState(false);
  const [parentGroupOpen, setParentGroupOpen] = useState(false);
  const [showDeleteAccountConfirm, setShowDeleteAccountConfirm] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: number[]) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return apiRequest("POST", "/api/vouchers/bulk-delete", { voucherIds: ids });
    },
    onSuccess: (_, ids) => {
      toast({ title: `Deleted ${ids.length} voucher(s)` });
      setSelectedVoucherIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      if (selectedAccount) {
        const accountType = (selectedAccount.type || "").toLowerCase().replace(" ", "-");
        queryClient.invalidateQueries({
          queryKey: [`/api/accounts/${accountType}/${selectedAccount.accountId}/transactions`],
        });
      }
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Delete failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const { data: voucherSearchResults = [], isLoading: voucherSearchLoading } = useQuery<VoucherSearchResult[]>({
    queryKey: ["/api/vouchers/search", debouncedFindQuery],
    queryFn: async () => {
      if (!debouncedFindQuery.trim()) return [];
      const res = await fetch(`/api/vouchers/search?q=${encodeURIComponent(debouncedFindQuery)}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Search failed");
      return res.json();
    },
    enabled: debouncedFindQuery.trim().length > 0,
    // Only re-fetch when the search term itself changes — never on window
    // focus or background intervals, so typing is never interrupted.
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchInterval: false,
  });

  // Form instances are created before the mutations whose callbacks reset them.
  const bankForm = useForm<Omit<InsertBankAccount, "companyId">>({
    resolver: zodResolver(insertBankAccountSchema.omit({ companyId: true })),
  });
  const editForm = useForm<Omit<UpdateLedgerAccount, "id" | "companyId">>({
    resolver: zodResolver(updateLedgerAccountSchema.omit({ id: true, companyId: true })),
  });

  const deleteLedgerMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/ledger-accounts/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Account deleted" });
      setAlterSelectedAccount(null);
      editForm.reset();
      queryClient.invalidateQueries({ queryKey: [accountsListUrl] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Cannot delete", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const updateLedgerMutation = useMutation({
    mutationFn: async (data: {
      id: number;
      name?: string;
      accountType?: string;
      subType?: string | null;
      openingBalance?: string;
      openingBalanceSide?: string;
      active?: boolean;
      parentId?: number | null | undefined;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const { id, ...rest } = data;
      return apiRequest("PUT", `/api/ledger-accounts/${id}`, rest);
    },
    onSuccess: () => {
      toast({ title: "Account updated successfully" });
      queryClient.invalidateQueries({ queryKey: [accountsListUrl] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const updateBankMutation = useMutation({
    mutationFn: async (data: { id: number } & Record<string, unknown>) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const { id, ...rest } = data;
      const res = await apiRequest("PUT", `/api/bank-accounts/${id}`, rest);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Update failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bank account updated" });
      setBankToEdit(null);
      bankForm.reset();
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: [accountsListUrl] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const deleteBankMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/bank-accounts/${id}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bank account deleted" });
      setBankToEdit(null);
      bankForm.reset();
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: [accountsListUrl] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Delete failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const createBankMutation = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      const res = await apiRequest("POST", "/api/bank-accounts", {
        ...data,
        companyId: selectedCompany?.id,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? "Create failed");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Bank account created" });
      setBankToEdit(null);
      bankForm.reset();
      queryClient.invalidateQueries({ queryKey: ["/api/bank-accounts"] });
      queryClient.invalidateQueries({ queryKey: [accountsListUrl] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Create failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  return {
    selectedCompany,
    toast,
    recordChanges,
    canCreateBankAccount,
    formatDisplayDate,
    formatAmount,
    isMultiCurrency,
    formatAmountForAccount,
    hideBalances,
    appMode,
    accountsListUrl,
    modePrefix,
    modeApiRequest,
    navigate,
    urlAccountId,
    urlAccountType,
    selectedAccount,
    setSelectedAccount,
    fromExternalNavRef,
    searchTerm,
    setSearchTerm,
    periodFilter,
    setPeriodFilter,
    accountToEdit,
    setAccountToEdit,
    supplierToEdit,
    setSupplierToEdit,
    customerToEdit,
    setCustomerToEdit,
    employeeToEdit,
    setEmployeeToEdit,
    bankToEdit,
    setBankToEdit,
    pendingDelete,
    setPendingDelete,
    alterSelectedAccount,
    setAlterSelectedAccount,
    findQuery,
    setFindQuery,
    debouncedFindQuery,
    expandedParents,
    setExpandedParents,
    selectedVoucherIds,
    setSelectedVoucherIds,
    showBulkDeleteConfirm,
    setShowBulkDeleteConfirm,
    showDeletedVouchers,
    setShowDeletedVouchers,
    parentGroupOpen,
    setParentGroupOpen,
    showDeleteAccountConfirm,
    setShowDeleteAccountConfirm,
    editDialogOpen,
    setEditDialogOpen,
    bulkDeleteMutation,
    voucherSearchResults,
    voucherSearchLoading,
    bankForm,
    editForm,
    deleteLedgerMutation,
    updateLedgerMutation,
    updateBankMutation,
    deleteBankMutation,
    createBankMutation,
  };
}
