// Extracted from ./useAccountsLegacyModel.ts: account list, filters and the continuous statement query.
import { searchAny } from "@shared/searchNormalization";
import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useRef, useMemo, useEffect } from "react";
import { useQuery, useMutation, useInfiniteQuery } from "@tanstack/react-query";
import { type SubmitHandler } from "react-hook-form";
import { useReactToPrint } from "react-to-print";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { fetchAccountStatementChunk, type AccountStatementChunk } from "@/lib/accountStatementContinuousClient";
import type { InsertBankAccount } from "@shared/schema";
import { Account, Transaction, WaRule, WaChat } from "../accounts/accountTypes";
import { useAccountsLegacyDialogsModel } from "./useAccountsLegacyDialogsModel";
import type { GroupOption } from "./useAccountsLegacyModel";
import { DEFAULT_WA_RULE } from "./useAccountsLegacyModel";

export function useAccountsLegacyStatementModel() {
  const d = useAccountsLegacyDialogsModel();

  const onBankSubmit: SubmitHandler<Omit<InsertBankAccount, "companyId">> = (data) => {
    if (d.bankToEdit) {
      d.updateBankMutation.mutate({ id: d.bankToEdit.id, ...data });
    } else {
      d.createBankMutation.mutate(data);
    }
  };

  const handleDeleteBankAccount = () => {
    if (d.bankToEdit) d.deleteBankMutation.mutate(d.bankToEdit.id);
  };

  const [filterCurrency, setFilterCurrency] = useState<"all" | "CFA">("all");
  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const [exportLang, setExportLang] = useState<"en" | "fr" | "ar">("en");

  // ─── WhatsApp rule state ─────────────────────────────────────────────────
  const [waRuleDialogOpen, setWaRuleDialogOpen] = useState(false);
  const [waRuleDraft, setWaRuleDraft] = useState<WaRule>(DEFAULT_WA_RULE);
  const [waChatSearch, setWaChatSearch] = useState("");

  const selectedAccountIsLedger = !!d.selectedAccount?.accountId;
  const selectedAccountId = d.selectedAccount?.accountId ?? null;

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

  const waRuleBase = d.appMode === "factory" ? "/api/factory/accounts" : "/api/accounts";
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
    return waChatsRaw.filter((c) => searchAny(waChatSearch, c.name));
  }, [waChatsRaw, waChatSearch]);

  const openWaRuleDialog = () => {
    setWaRuleDraft(waRule ?? DEFAULT_WA_RULE);
    setWaChatSearch("");
    setWaRuleDialogOpen(true);
  };

  const saveWaRuleMutation = useMutation({
    mutationFn: async (rule: WaRule) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const res = await apiRequest("PUT", `${waRuleBase}/${selectedAccountId}/whatsapp-rule`, rule);
      if (!res.ok) throw new Error(await res.text());
      return res.json();
    },
    onSuccess: () => {
      d.toast({ title: "WhatsApp rule saved" });
      setWaRuleDialogOpen(false);
      queryClient.invalidateQueries({ queryKey: [waRuleBase, selectedAccountId, "whatsapp-rule"] });
    },
    onError: (err: ClientErrorLike) => {
      d.toast({ title: "Save failed", description: err?.message ?? "Unknown error", variant: "destructive" });
    },
  });

  const sendWaStatementMutation = useMutation({
    mutationFn: async ({ accountId, month }: { accountId: number; month: string }) => {
      if (!d.recordChanges.allowed) throw new Error(d.recordChanges.reason ?? "");
      const url =
        d.appMode === "factory"
          ? `/api/factory/accounts/${accountId}/send-statement-whatsapp`
          : `/api/accounts/${accountId}/send-statement-whatsapp`;
      const res = await apiRequest("POST", url, { month });
      if (!res.ok) throw new Error((await res.json()).message || "Send failed");
      return res.json();
    },
    onSuccess: () => {
      d.toast({ title: "Statement sent to WhatsApp" });
    },
    onError: (err: ClientErrorLike) => {
      d.toast({ title: "WhatsApp send failed", description: err?.message, variant: "destructive" });
    },
  });

  const printRef = useRef<HTMLDivElement>(null);
  const handlePrint = useReactToPrint({
    contentRef: printRef,
    documentTitle: d.selectedAccount ? `Statement - ${d.selectedAccount.name}` : "Account Statement",
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
    queryKey: [d.accountsListUrl, d.selectedCompany?.id, d.periodFilter.toDate || null, "book-balance", d.appMode],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (d.periodFilter.toDate) params.set("endDate", d.periodFilter.toDate);
      // The Accounts page and its statements must reconcile with posted voucher
      // USD amounts; current-rate FX values belong to the valuation report.
      if (d.appMode !== "factory") params.set("balanceBasis", "book");
      const res = await fetch(`${d.accountsListUrl}?${params.toString()}`, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message || `Failed to load accounts (${res.status})`);
      }
      return res.json();
    },
    enabled: !!d.selectedCompany,
  });
  // Show customer-linked balances exactly as Factory Parties does, including
  // held pre-finalization charges and legacy operational amounts. Keep the
  // server's GL book balance unchanged for other accounting consumers.
  const allAccounts: Account[] = useMemo(() => {
    const accounts = accountsResponse?.accounts ?? [];
    return accounts.map((account) => {
      if (account.partyBalance === undefined) return account;
      return {
        ...account,
        balance: Number(account.partyBalance),
        balanceSide: account.partyBalanceSide ?? account.balanceSide,
      };
    });
  }, [accountsResponse?.accounts]);

  // Auto-select account when navigated here from ledger monthly summary (or any deep-link with ?accountId=)
  const { urlAccountId, selectedAccount, urlAccountType, fromExternalNavRef, setSelectedAccount } = d;
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
  }, [allAccounts, selectedAccount, urlAccountId, urlAccountType, fromExternalNavRef, setSelectedAccount]);

  // Dedicated query for Group accounts used by the Parent Group combobox.
  // Uses the server's parent-group-only endpoint so
  // groups created there always appear here without needing /api/accounts/all to refresh.
  // Groups = accounts marked with subType "Group" OR accounts that happen to have children
  // (backward-compat: groups created before subType tagging still show up)
  const { data: groupOptions = [] } = useQuery<GroupOption[]>({
    queryKey: ["/api/ledger-accounts/parent-groups", d.selectedCompany?.id],
    queryFn: async () => {
      const url = `/api/ledger-accounts/parent-groups?companyId=${d.selectedCompany!.id}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch ledger accounts");
      return res.json();
    },
    // The server returns tagged and legacy parent groups already filtered.
    // Re-filtering this narrowed result would incorrectly drop legacy parents.
    enabled: !!d.selectedCompany,
  });

  const accountStatementBaseKey = d.selectedAccount
    ? [
        "account-statement",
        d.selectedCompany?.id,
        d.selectedAccount.type,
        d.selectedAccount.accountId,
        d.periodFilter.fromDate || null,
        d.periodFilter.toDate || null,
      ]
    : ["account-statement", "disabled"];

  const accountStatementUrl = useMemo(() => {
    if (!d.selectedAccount) return "";
    const params = new URLSearchParams();
    if (d.periodFilter.fromDate) params.append("startDate", d.periodFilter.fromDate);
    if (d.periodFilter.toDate) params.append("endDate", d.periodFilter.toDate);
    if (d.selectedAccount.type === "factoryWorker") {
      return `/api/factory/workers/${d.selectedAccount.accountId}/statement?${params.toString()}`;
    }
    const accountType = (d.selectedAccount.type || "").toLowerCase().replace(" ", "-");
    return `/api/accounts/${accountType}/${d.selectedAccount.accountId}/transactions?${params.toString()}`;
  }, [d.selectedAccount, d.periodFilter.fromDate, d.periodFilter.toDate]);

  const {
    data: statementPages,
    isLoading: transactionsLoading,
    isError: transactionsQueryIsError,
    error: transactionsQueryError,
    hasNextPage: statementHasNextPage,
    isFetchingNextPage: statementFetchingNextPage,
    fetchNextPage: fetchNextStatementPage,
  } = useInfiniteQuery({
    queryKey: [...accountStatementBaseKey, "continuous-pages"],
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }): Promise<AccountStatementChunk<Transaction>> => {
      if (!d.selectedAccount) throw new Error("Account selection is required");
      if (d.selectedAccount.type !== "factoryWorker") {
        return fetchAccountStatementChunk<Transaction>(accountStatementUrl, pageParam, signal);
      }

      const response = await fetch(accountStatementUrl, { credentials: "include", signal });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const message =
          payload && typeof payload === "object" && "message" in payload && typeof payload.message === "string"
            ? payload.message
            : `Failed to load account statement (${response.status})`;
        throw new Error(message);
      }
      const workerTransactions = (
        Array.isArray(payload)
          ? payload
          : payload && typeof payload === "object" && "transactions" in payload && Array.isArray(payload.transactions)
            ? payload.transactions
            : []
      ) as Transaction[];
      const preNetBalance =
        payload && !Array.isArray(payload) && typeof payload === "object" && "preNetBalance" in payload
          ? Number(payload.preNetBalance) || 0
          : 0;
      const periodDebitTotal = workerTransactions.reduce(
        (sum, row) => sum + (Number.parseFloat(row.debitAmount) || 0),
        0
      );
      const periodCreditTotal = workerTransactions.reduce(
        (sum, row) => sum + (Number.parseFloat(row.creditAmount) || 0),
        0
      );
      return {
        transactions: workerTransactions,
        preNetBalance,
        periodPreNetBalance: preNetBalance,
        periodDebitTotal,
        periodCreditTotal,
        closingNetBalance: preNetBalance + periodDebitTotal - periodCreditTotal,
        total: workerTransactions.length,
        limit: Math.max(workerTransactions.length, 1),
        asOfDate: d.periodFilter.toDate || "",
        startDate: d.periodFilter.fromDate || null,
        endDate: d.periodFilter.toDate || "",
        continuous: true,
        chunkOpeningNet: preNetBalance,
        hasMore: false,
        nextCursor: null,
      };
    },
    getNextPageParam: (lastPage: AccountStatementChunk<Transaction>) =>
      lastPage.hasMore && lastPage.nextCursor ? lastPage.nextCursor : undefined,
    enabled: !!d.selectedAccount,
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  useEffect(() => {
    if (!statementHasNextPage || statementFetchingNextPage || transactionsQueryIsError) return;
    void fetchNextStatementPage();
  }, [statementHasNextPage, statementFetchingNextPage, transactionsQueryIsError, fetchNextStatementPage]);

  const rawTransactionData = useMemo(() => {
    const pages = statementPages?.pages ?? [];
    const first = pages[0];
    if (!first) return undefined;
    return {
      ...first,
      transactions: pages.flatMap((page) => page.transactions),
    };
  }, [statementPages?.pages]);

  useEffect(() => {
    if (!selectedAccount || !rawTransactionData) return;
    queryClient.setQueryData(accountStatementBaseKey, rawTransactionData);
    // The key array is rebuilt every render; its joined value is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by the joined statement key
  }, [selectedAccount, rawTransactionData, accountStatementBaseKey.join("|")]);

  return {
    d,
    onBankSubmit,
    handleDeleteBankAccount,
    filterCurrency,
    setFilterCurrency,
    currentUser,
    exportLang,
    setExportLang,
    waRuleDialogOpen,
    setWaRuleDialogOpen,
    waRuleDraft,
    setWaRuleDraft,
    waChatSearch,
    setWaChatSearch,
    selectedAccountIsLedger,
    waChatsLoading,
    waRule,
    filteredWaChats,
    openWaRuleDialog,
    saveWaRuleMutation,
    sendWaStatementMutation,
    printRef,
    handlePrint,
    accountsLoading,
    accountsError,
    accountsQueryError,
    refetchAccounts,
    allAccounts,
    groupOptions,
    transactionsLoading,
    transactionsQueryError,
    rawTransactionData,
  };
}
