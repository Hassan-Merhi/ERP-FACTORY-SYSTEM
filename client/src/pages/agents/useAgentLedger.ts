/**
 * Data layer for the Agent Ledger page: every query and mutation the page
 * used to own inline. Query keys, selectors, URLs, and cache-invalidation
 * behaviour are identical to the original implementation in pages/Agents.tsx.
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { selectAccountsArray, type AccountsAllPayload } from "@/lib/accountsAllPayload";
import type { PeriodFilterValue } from "@/components/ui/period-filter";
import type { Account, Transaction } from "./agentStatementMath";

/** The toast callable shape used by the mutation callbacks. */
type ToastFn = (props: { title?: string; description?: string; variant?: "default" | "destructive" }) => void;

export interface AgentAccount {
  id: number;
  companyId: number;
  accountId: string;
  accountType: string;
  accountName: string;
}

export function useAgentLedger(
  selectedCompany: { id?: number | null } | undefined | null,
  selectedAccount: Account | null,
  periodFilter: PeriodFilterValue,
  setSelectedAccount: (account: Account | null) => void,
  toast: ToastFn
) {
  // Factory routes resolve their own pinned company; shared ERP routes follow
  // currentCompanyId, which may differ when another browser tab switches ERP.
  const isFactory = typeof window !== "undefined" && window.location.pathname.startsWith("/factory/");
  const accountsUrl = isFactory ? "/api/factory/agents/accounts" : "/api/accounts/all";
  const pinnedUrl = isFactory ? "/api/factory/agents/pinned" : "/api/agent-accounts";
  const statementPrefix = isFactory ? "/api/factory/agents" : "/api/accounts";

  // Preserve the server envelope in the shared cache and normalize only for
  // this screen. That keeps navigation safe for pages that share this query key.
  const { data: allAccounts = [], isLoading: accountsLoading } = useQuery<
    AccountsAllPayload<Account>,
    Error,
    Account[]
  >({
    queryKey: [accountsUrl, selectedCompany?.id],
    select: selectAccountsArray,
    enabled: !!selectedCompany,
  });

  const { data: agentAccountRows = [], isLoading: agentsLoading } = useQuery<AgentAccount[]>({
    queryKey: [pinnedUrl, selectedCompany?.id],
    enabled: !!selectedCompany,
  });

  const accountTypeUrl = selectedAccount
    ? selectedAccount.type === "fixedAsset"
      ? "fixed-asset"
      : (selectedAccount.type || "").toLowerCase().replace(/[\s_]+/g, "-")
    : null;
  const { data: transactions = [], isLoading: transactionsLoading } = useQuery<Transaction[]>({
    queryKey: selectedAccount
      ? [
          `${statementPrefix}/${accountTypeUrl}/${selectedAccount.accountId}/transactions`,
          { startDate: periodFilter.fromDate, endDate: periodFilter.toDate },
        ]
      : [],
    queryFn: async () => {
      if (!selectedAccount) return [];
      const params = new URLSearchParams();
      if (periodFilter.fromDate) params.append("startDate", periodFilter.fromDate);
      if (periodFilter.toDate) params.append("endDate", periodFilter.toDate);
      const url = `${statementPrefix}/${accountTypeUrl}/${selectedAccount.accountId}/transactions${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch transactions");
      const data = await res.json();
      return Array.isArray(data) ? data : (data.transactions ?? []);
    },
    enabled: !!selectedAccount,
  });

  const { data: prePeriodData } = useQuery<{ balance: number }>({
    queryKey:
      selectedAccount && periodFilter.fromDate
        ? [
            `${statementPrefix}/${accountTypeUrl}/${selectedAccount.accountId}/pre-period-balance`,
            { endDate: periodFilter.fromDate },
          ]
        : [],
    queryFn: async () => {
      if (!selectedAccount || !periodFilter.fromDate) return { balance: 0 };
      const res = await fetch(
        `${statementPrefix}/${accountTypeUrl}/${selectedAccount.accountId}/pre-period-balance?endDate=${encodeURIComponent(periodFilter.fromDate)}`,
        { credentials: "include" }
      );
      if (!res.ok) return { balance: 0 };
      return res.json();
    },
    enabled: !!selectedAccount && !!periodFilter.fromDate,
  });

  const addMutation = useMutation({
    mutationFn: async (account: Account) => {
      const res = await fetch(pinnedUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ accountId: account.id, accountType: account.type, accountName: account.name }),
      });
      if (!res.ok) throw new Error("Failed to add agent");
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [pinnedUrl] });
      toast({ title: "Account added to Agent Ledger" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const removeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      const res = await fetch(`${pinnedUrl}/${encodeURIComponent(accountId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to remove agent");
      return res.json();
    },
    onSuccess: (_, accountId) => {
      queryClient.invalidateQueries({ queryKey: [pinnedUrl] });
      if (selectedAccount?.id === accountId) setSelectedAccount(null);
      toast({ title: "Account removed from Agent Ledger" });
    },
    onError: (e: Error) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return {
    allAccounts,
    accountsLoading,
    agentAccountRows,
    agentsLoading,
    transactions,
    transactionsLoading,
    prePeriodData,
    addMutation,
    removeMutation,
  };
}
