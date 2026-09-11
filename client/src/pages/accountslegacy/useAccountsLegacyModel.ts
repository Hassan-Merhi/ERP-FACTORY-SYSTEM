import type { ClientErrorLike } from "@/lib/clientError";
/**
 * Controller hook for the legacy Accounts Overview page.
 *
 * Holds the account list and statement queries, the running-balance
 * derivation, the ledger/bank/WhatsApp mutations, the two edit forms and the
 * voucher navigation map. Views render this model and nothing else.
 */
import { useState, useRef, useCallback, useMemo, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { useForm, type SubmitHandler } from "react-hook-form";
import { zodResolver } from "@/lib/form-resolver";
import { useReactToPrint } from "react-to-print";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useAppMode, useModePrefix } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useDateJump } from "@/hooks/use-date-jump";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useDebounce } from "@/hooks/use-debounce";
import { getDefaultPeriodValue, PeriodFilterValue } from "@/components/ui/period-filter";
import { LedgerAccount, BankAccount, insertBankAccountSchema, updateLedgerAccountSchema } from "@shared/schema";
import type { InsertBankAccount, UpdateLedgerAccount } from "@shared/schema";
import { Account, Transaction, WaRule, WaChat } from "../accounts/accountTypes";

/** Voucher type → Vouchers page tab, for statement row navigation. */
const VOUCHER_TAB_MAP: Record<string, string> = {
  payment: "payment",
  receipt: "receipt",
  journal: "journal",
  contra: "journal",
  stocktransfer: "transferorder",
  "stock transfer": "transferorder",
  transfer: "transfer",
  creditnote: "creditnote",
  "credit note": "creditnote",
  debitnote: "creditnote",
  "debit note": "creditnote",
  production: "adjustment",
  consumption: "adjustment",
  mixed: "adjustment",
};

const DEFAULT_WA_RULE: WaRule = {
  enabled: false,
  whatsappChatId: "",
  sendOnPayment: true,
  sendOnReceipt: true,
  sendOnJournal: true,
};

interface VoucherSearchResult {
  id: number;
  voucherType?: string | null;
  locationName?: string | null;
  description?: string | null;
  totalAmount?: string | null;
  currency?: string | null;
  effectiveDate?: string | null;
  voucherDate: string;
}

interface GroupOption {
  id: number;
  name: string;
  parentId?: number | null;
  subType?: string | null;
}

interface VoucherNavigationRow {
  voucherId: number;
  voucherType?: string | null;
}

interface PayrollMigrationResponse {
  vouchersUpdated?: number;
  accountsDeleted?: number;
  salaryAccountsReparented?: number;
  bonusAccountsReparented?: number;
}

export function useAccountsLegacyModel() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount, formatHistoricalBaseAmount, isMultiCurrency } = useCurrencyContext();

  // Account-list and statement balances are historical base values. They must
  // not change when the user changes the current display-rate preference.
  function formatAmountForAccount(amount: number, _accountType?: string): string {
    return formatHistoricalBaseAmount(amount);
  }
  const { data: myErpPages } = useQuery<{ hiddenErpCostFields?: string[] }>({ queryKey: ["/api/my-erp-pages"] });
  const hideBalances = (myErpPages?.hiddenErpCostFields ?? []).includes("accounts_balances");
  const appMode = useAppMode();
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
    return getDefaultPeriodValue("this_month");
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
    mutationFn: async (ids: number[]) => apiRequest("POST", "/api/vouchers/bulk-delete", { voucherIds: ids }),
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

  const deleteLedgerMutation = useMutation({
    mutationFn: async (id: number) => {
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
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
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
      const { id, ...rest } = data;
      return apiRequest("PUT", `/api/ledger-accounts/${id}`, rest);
    },
    onSuccess: () => {
      toast({ title: "Account updated successfully" });
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const updateBankMutation = useMutation({
    mutationFn: async (data: { id: number } & Record<string, unknown>) => {
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
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Update failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const deleteBankMutation = useMutation({
    mutationFn: async (id: number) => {
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
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
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
      queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Create failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const onBankSubmit: SubmitHandler<Omit<InsertBankAccount, "companyId">> = (data) => {
    if (bankToEdit) {
      updateBankMutation.mutate({ id: bankToEdit.id, ...data });
    } else {
      createBankMutation.mutate(data);
    }
  };

  const handleDeleteBankAccount = () => {
    if (bankToEdit) deleteBankMutation.mutate(bankToEdit.id);
  };

  const [filterCurrency, setFilterCurrency] = useState<"all" | "CFA">("all");
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const [exportLang, setExportLang] = useState<"en" | "fr" | "ar">("en");

  const fixPayrollAccountsMutation = useMutation({
    mutationFn: async (): Promise<PayrollMigrationResponse> => {
      const response = await apiRequest("POST", "/api/factory/payroll/migrate-worker-names", {
        companyId: selectedCompany?.id,
        confirm: true,
      });
      return response.json();
    },
    onSuccess: (data: PayrollMigrationResponse) => {
      queryClient.invalidateQueries({ queryKey: ["/api/accounts"] });
      toast({
        title: "Payroll accounts fixed",
        description: `${data.vouchersUpdated ?? 0} voucher(s) updated · ${data.accountsDeleted ?? 0} old account(s) removed · ${(data.salaryAccountsReparented ?? 0) + (data.bonusAccountsReparented ?? 0)} account(s) grouped`,
      });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Fix failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  // ─── WhatsApp rule state ─────────────────────────────────────────────────
  const [waRuleDialogOpen, setWaRuleDialogOpen] = useState(false);
  const [waRuleDraft, setWaRuleDraft] = useState<WaRule>(DEFAULT_WA_RULE);
  const [waChatSearch, setWaChatSearch] = useState("");

  const selectedAccountIsLedger = !!selectedAccount?.accountId;
  const selectedAccountId = selectedAccount?.accountId ?? null;

  const { data: waChatsRaw = [], isLoading: waChatsLoading } = useQuery<WaChat[]>({
    queryKey: ["/api/whatsapp/chats/pos"],
    queryFn: async () => {
      const res = await fetch("/api/whatsapp/chats/pos", { credentials: "include" });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 60_000,
    enabled: waRuleDialogOpen,
  });

  const waRuleBase = appMode === "factory" ? "/api/factory/accounts" : "/api/accounts";
  const { data: waRule = null } = useQuery<WaRule | null>({
    queryKey: [waRuleBase, selectedAccountId, "whatsapp-rule"],
    queryFn: async () => {
      const res = await fetch(`${waRuleBase}/${selectedAccountId}/whatsapp-rule`, { credentials: "include" });
      if (!res.ok) return null;
      return res.json();
    },
    enabled: selectedAccountIsLedger && !!selectedAccountId,
    staleTime: 30_000,
  });

  const filteredWaChats = useMemo(() => {
    if (!waChatSearch.trim()) return waChatsRaw;
    const s = waChatSearch.toLowerCase();
    return waChatsRaw.filter((c) => c.name.toLowerCase().includes(s));
  }, [waChatsRaw, waChatSearch]);

  const openWaRuleDialog = () => {
    setWaRuleDraft(waRule ?? DEFAULT_WA_RULE);
    setWaChatSearch("");
    setWaRuleDialogOpen(true);
  };

  const saveWaRuleMutation = useMutation({
    mutationFn: async (rule: WaRule) => {
      const res = await apiRequest("PUT", `${waRuleBase}/${selectedAccountId}/whatsapp-rule`, rule);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "WhatsApp rule saved" });
      setWaRuleDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: [waRuleBase, selectedAccountId, "whatsapp-rule"] });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "Save failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const sendWaStatementMutation = useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      const url =
        appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const res = await apiRequest("POST", url, { month });
      if (!res.ok) throw new Error((await res.json()).message || "Send failed");
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Statement sent to WhatsApp" });
    },
    onError: (err: ClientErrorLike) => {
      toast({ title: "WhatsApp send failed", description: err?.message, variant: "destructive" });
    },
  });

  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: selectedAccount ? `Statement - ${selectedAccount.name}` : "Account Statement",
  });

  // Accounts query — includes the selected period end date so the list balance
  // is always computed through the same cut-off as the opened statement.
  const {
    data: accountsResponse,
    isLoading: accountsLoading,
    isError: accountsError,
    error: accountsQueryError,
    refetch: refetchAccounts,
  } = useQuery<{
    accounts: Account[];
    asOfDate: string;
  }>({
    queryKey: ["/api/accounts/all", selectedCompany?.id, periodFilter.toDate || null],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (periodFilter.toDate) params.set("endDate", periodFilter.toDate);
      const res = await fetch(`/api/accounts/all?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to load accounts (${res.status})`);
      }
      return res.json();
    },
    enabled: !!selectedCompany,
  });
  const allAccounts: Account[] = useMemo(() => accountsResponse?.accounts ?? [], [accountsResponse?.accounts]);

  // Auto-select account when navigated here from ledger monthly summary (or any deep-link with ?accountId=)
  useEffect(() => {
    if (!urlAccountId || !allAccounts.length || selectedAccount) return;
    const numId = parseInt(urlAccountId, 10);
    const found = urlAccountType
      ? allAccounts.find((a) => a.accountId === numId && a.type === urlAccountType)
      : allAccounts.find((a) => a.accountId === numId);
    if (found) {
      fromExternalNavRef.current = true;
      setSelectedAccount(found);
    }
  }, [allAccounts, selectedAccount, urlAccountId, urlAccountType]);

  // Dedicated query for Group accounts used by the Parent Group combobox.
  // Uses /api/ledger-accounts directly (same source as Account Groups page) so
  // groups created there always appear here without needing /api/accounts/all to refresh.
  // Groups = accounts marked with subType "Group" OR accounts that happen to have children
  // (backward-compat: groups created before subType tagging still show up)
  const { data: groupOptions = [] } = useQuery<GroupOption[]>({
    queryKey: ["/api/ledger-accounts", selectedCompany?.id],
    queryFn: async () => {
      const url = selectedCompany?.id ? `/api/ledger-accounts?companyId=${selectedCompany.id}` : "/api/ledger-accounts";
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ledger accounts");
      return res.json();
    },
    select: (data) => {
      const parentIdSet = new Set<number>();
      data.forEach((a) => {
        if (a.parentId) parentIdSet.add(a.parentId);
      });
      return data.filter((a) => a.subType === "Group" || parentIdSet.has(a.id));
    },
    enabled: !!selectedCompany,
  });

  const {
    data: rawTransactionData,
    isLoading: transactionsLoading,
    error: transactionsQueryError,
  } = useQuery({
    queryKey: selectedAccount
      ? [
          "account-statement",
          selectedCompany?.id,
          selectedAccount.type,
          selectedAccount.accountId,
          periodFilter.fromDate || null,
          periodFilter.toDate || null,
        ]
      : [],
    queryFn: async () => {
      if (!selectedAccount) return [];
      const params = new URLSearchParams();
      if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);
      if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);

      let url;
      if (selectedAccount.type === "factoryWorker") {
        url = `/api/factory/workers/${selectedAccount.accountId}/statement?${params.toString()}`;
      } else {
        const accountType = (selectedAccount.type || "").toLowerCase().replace(" ", "-");
        url = `/api/accounts/${accountType}/${selectedAccount.accountId}/transactions?${params.toString()}`;
      }
      const response = await fetch(url, { credentials: "include" });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.message || `Failed to load account statement (${response.status})`);
      }
      return payload;
    },
    enabled: !!selectedAccount,
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
  });

  // Unwrap response — when a startDate filter is active the backend returns
  // { transactions, preNetBalance } so we can compute the correct opening balance.
  const transactions: Transaction[] = useMemo(() => {
    if (!rawTransactionData) return [];
    if (Array.isArray(rawTransactionData)) return rawTransactionData;
    return rawTransactionData.transactions ?? [];
  }, [rawTransactionData]);

  // broughtForwardBalance = stored account opening balance + net of all entries before the period start.
  // openingBalance from the API is always an unsigned positive number; openingBalanceSide carries the sign.
  // Cr opening balances must be negated (convention: positive = Dr, negative = Cr).
  const broughtForwardBalance = useMemo(() => {
    const rawOB = parseFloat(String(selectedAccount?.openingBalance ?? 0)) || 0;
    const obSide = selectedAccount?.openingBalanceSide || "Dr";
    const storedOB = obSide === "Cr" ? -rawOB : rawOB;
    if (!rawTransactionData || Array.isArray(rawTransactionData)) return storedOB;
    return storedOB + (rawTransactionData.preNetBalance ?? 0);
  }, [rawTransactionData, selectedAccount]);

  // Derived state
  const vouchersWithBalance = useMemo(() => {
    if (!transactions.length) return [];
    let runBal = broughtForwardBalance;
    return transactions.map((t) => {
      const dr = parseFloat(t.debitAmount) || 0;
      const cr = parseFloat(t.creditAmount) || 0;
      runBal += dr - cr;
      return { ...t, totalDebit: dr, totalCredit: cr, runningBalance: runBal };
    });
  }, [transactions, broughtForwardBalance]);

  const closingBalance = useMemo(() => {
    if (vouchersWithBalance.length > 0) {
      return vouchersWithBalance[vouchersWithBalance.length - 1].runningBalance;
    }
    return broughtForwardBalance;
  }, [vouchersWithBalance, broughtForwardBalance]);

  const filteredAccounts = useMemo(() => {
    const searchLower = searchTerm.toLowerCase();
    return allAccounts.filter(
      (a) => a.name.toLowerCase().includes(searchLower) || a.code.toLowerCase().includes(searchLower)
    );
  }, [allAccounts, searchTerm]);

  // Handlers
  const toggleParent = (id: string) => {
    setExpandedParents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleAccountChange = (id: string) => {
    const acc = allAccounts.find((a) => a.id === id);
    if (acc) {
      setSelectedAccount(acc);
      updateUrlParams({ accountId: String(acc.accountId), accountType: acc.type });
    }
  };

  const toggleVoucherSelection = (voucherId: number) => {
    setSelectedVoucherIds((prev) => {
      const next = new Set(prev);
      if (next.has(voucherId)) next.delete(voucherId);
      else next.add(voucherId);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedVoucherIds.size === vouchersWithBalance.length) setSelectedVoucherIds(new Set());
    else setSelectedVoucherIds(new Set(vouchersWithBalance.map((v) => v.voucherId)));
  };

  const handleOpenVoucher = (v: VoucherNavigationRow) => {
    const id = v.voucherId;
    const rawType = (v.voucherType || "").toLowerCase().replace(/\s+/g, "");

    // POS / Sales → open in the POS edit page
    if (rawType === "sales" || rawType === "pos") {
      navigate(`${modePrefix.replace(/^\/erp/, "")}/pos/edit/${id}`);
      return;
    }

    // Purchase → try to resolve the container; fall back to vouchers page
    if (rawType === "purchase") {
      fetch(`/api/vouchers/${id}/view-entries`, { credentials: "include" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          const po = data && !Array.isArray(data) ? data.purchaseOrder : null;
          if (po?.containerId) {
            navigate(`${modePrefix}/containers/${po.containerId}`);
          } else {
            navigate(`${modePrefix}/vouchers?edit=${id}&tab=purchase`);
          }
        })
        .catch(() => navigate(`${modePrefix}/vouchers?edit=${id}&tab=purchase`));
      return;
    }

    // All other voucher types → map to the correct Vouchers tab
    const tab = VOUCHER_TAB_MAP[rawType] ?? "journal";
    navigate(`${modePrefix}/vouchers?edit=${id}&tab=${tab}`);
  };

  const bankForm = useForm<Omit<InsertBankAccount, "companyId">>({
    resolver: zodResolver(insertBankAccountSchema.omit({ companyId: true })),
  });

  // Populate bank form fields whenever a bank account is selected for editing.
  useEffect(() => {
    if (bankToEdit) {
      const openingBalanceSide = insertBankAccountSchema.shape.openingBalanceSide.safeParse(
        bankToEdit.openingBalanceSide ?? "Dr"
      );
      bankForm.reset({
        code: bankToEdit.code ?? "",
        name: bankToEdit.name ?? "",
        bankName: bankToEdit.bankName ?? "",
        accountNumber: bankToEdit.accountNumber ?? "",
        routingCode: bankToEdit.routingCode ?? "",
        openingBalance: bankToEdit.openingBalance ?? "0",
        openingBalanceSide: openingBalanceSide.success ? openingBalanceSide.data : "Dr",
      });
    } else {
      bankForm.reset();
    }
  }, [bankForm, bankToEdit]);
  const editForm = useForm<Omit<UpdateLedgerAccount, "id" | "companyId">>({
    resolver: zodResolver(updateLedgerAccountSchema.omit({ id: true, companyId: true })),
  });
  const alterAccountType = editForm.watch("accountType") as string | undefined;

  /** Opens the alter/edit dialog pre-filled from an account table row. */
  const openEditAccountDialog = (account: Account) => {
    setAlterSelectedAccount(account);
    const accountType = updateLedgerAccountSchema.shape.accountType.safeParse(account.accountType || account.type);
    editForm.reset({
      code: account.code,
      name: account.name,
      accountType: accountType.success ? accountType.data : undefined,
      subType: account.subType || "",
      openingBalance: String(Math.abs(account.openingBalance || 0)),
      openingBalanceSide: (account.openingBalanceSide as "Dr" | "Cr") || "Dr",
      active: account.active !== false,
      parentId: account.parentId ?? undefined,
    });
    setEditDialogOpen(true);
  };

  const closeEditAccountDialog = () => {
    setEditDialogOpen(false);
    setAlterSelectedAccount(null);
    editForm.reset();
  };

  return {
    // context / formatting
    selectedCompany,
    appMode,
    modePrefix,
    modeApiRequest,
    navigate,
    currentUser,
    formatAmount,
    formatAmountForAccount,
    formatDisplayDate,
    isMultiCurrency,
    hideBalances,
    // account list + statement
    accountsLoading,
    accountsError,
    accountsQueryError,
    refetchAccounts,
    allAccounts,
    filteredAccounts,
    searchTerm,
    setSearchTerm,
    selectedAccount,
    setSelectedAccount,
    handleAccountChange,
    expandedParents,
    toggleParent,
    periodFilter,
    setPeriodFilter,
    vouchersWithBalance,
    broughtForwardBalance,
    closingBalance,
    transactionsLoading,
    transactionsQueryError,
    filterCurrency,
    setFilterCurrency,
    showDeletedVouchers,
    setShowDeletedVouchers,
    selectedVoucherIds,
    toggleVoucherSelection,
    toggleSelectAll,
    handleOpenVoucher,
    printRef,
    handlePrint,
    exportLang,
    setExportLang,
    // find voucher tab
    findQuery,
    setFindQuery,
    debouncedFindQuery,
    voucherSearchResults,
    voucherSearchLoading,
    // dialogs / forms
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
    bankForm,
    onBankSubmit,
    handleDeleteBankAccount,
    pendingDelete,
    setPendingDelete,
    editForm,
    alterAccountType,
    alterSelectedAccount,
    editDialogOpen,
    setEditDialogOpen,
    openEditAccountDialog,
    closeEditAccountDialog,
    groupOptions,
    parentGroupOpen,
    setParentGroupOpen,
    showDeleteAccountConfirm,
    setShowDeleteAccountConfirm,
    showBulkDeleteConfirm,
    setShowBulkDeleteConfirm,
    // whatsapp
    waRule,
    waRuleDialogOpen,
    setWaRuleDialogOpen,
    waRuleDraft,
    setWaRuleDraft,
    waChatSearch,
    setWaChatSearch,
    filteredWaChats,
    waChatsLoading,
    selectedAccountIsLedger,
    openWaRuleDialog,
    // mutations
    bulkDeleteMutation,
    deleteLedgerMutation,
    updateLedgerMutation,
    updateBankMutation,
    deleteBankMutation,
    createBankMutation,
    saveWaRuleMutation,
    sendWaStatementMutation,
    fixPayrollAccountsMutation,
  };
}

export type AccountsLegacyModel = ReturnType<typeof useAccountsLegacyModel>;
