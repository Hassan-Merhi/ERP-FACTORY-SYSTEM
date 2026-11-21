// Extracted from ./useAccountsLegacyModel.ts: account list, filters and the continuous statement query.
import { useMemo, useEffect } from "react";
import { useQuery, useInfiniteQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { fetchAccountStatementChunk, type AccountStatementChunk } from "@/lib/accountStatementContinuousClient";
import { Account, Transaction } from "../accounts/accountTypes";
import type { GroupOption } from "./useAccountsLegacyModel";
import { useAccountsLegacyStatementModelPart1 } from "./useAccountsLegacyStatementModelPart1";

export function useAccountsLegacyStatementModel() {
  const {
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
  } = useAccountsLegacyStatementModelPart1();

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
