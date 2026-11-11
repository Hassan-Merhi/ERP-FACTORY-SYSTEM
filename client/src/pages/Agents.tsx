import { searchAny } from "@shared/searchNormalization";
/**
 * Agent Ledger page.
 *
 * Composes the agent list panel, the statement panel, and the add-account
 * dialog; data access lives in pages/agents/useAgentLedger.ts, statement
 * math in pages/agents/agentStatementMath.ts, and Excel export in
 * pages/agents/agentStatementExcel.ts. Behaviour is unchanged.
 */
import { useState, useCallback, useMemo, Suspense, lazy } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { BookOpen } from "lucide-react";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import {
  groupTransactions,
  computeOpeningBalance,
  computeRunningBalances,
  computeClosingBalance,
  computePeriodTotals,
  withPartyDisplayBalance,
  type Account,
} from "./agents/agentStatementMath";
import { useAgentLedger } from "./agents/useAgentLedger";
import { AgentListPanel } from "./agents/AgentListPanel";
const AgentStatementPanel = lazy(() =>
  import("./agents/AgentStatementPanel").then((m) => ({ default: m.AgentStatementPanel }))
);
const AddAgentDialog = lazy(() => import("./agents/AddAgentDialog").then((m) => ({ default: m.AddAgentDialog })));

export default function Agents() {
  const { selectedCompany } = useCompany();
  const factoryMode = useAppMode() === "factory";
  const { formatAmount, selectedCurrency, exchangeRate, isMultiCurrency, baseCurrency, displayCurrency } =
    useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("today"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [agentSearch, setAgentSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  useEscapeBack(selectedAccount ? () => setSelectedAccount(null) : null);
  const isPhone = useErpPhoneLayout();

  const {
    allAccounts,
    accountsLoading,
    agentAccountRows,
    agentsLoading,
    accountsError,
    agentsError,
    retryAccounts,
    retryAgents,
    transactions,
    transactionsLoading,
    prePeriodData,
    addMutation,
    removeMutation,
  } = useAgentLedger(selectedCompany, selectedAccount, periodFilter, setSelectedAccount, toast);

  // Native FX-agent wallet is an independent denomination view; never
  // reinterpret historical USD journal columns as native EUR.
  const { data: fxWalletData } = useQuery<{
    wallets: Array<{
      wallet: { ledgerAccountId: number };
      state: { usd: string; eur: string; eurBookUsd: string };
      currentUsd: string | null;
      synchronized: boolean;
    }>;
  }>({
    queryKey: ["/api/factory/fx-agent-wallets", selectedCompany?.id, "agent-ledger"],
    queryFn: async () => {
      const response = await fetch("/api/factory/fx-agent-wallets", { credentials: "include" });
      if (!response.ok) throw new Error("Cannot load native FX agent balance");
      return response.json();
    },
    enabled: factoryMode && !!selectedAccount && !!selectedCompany,
    staleTime: 30_000,
  });
  const selectedFxWallet = fxWalletData?.wallets?.find(
    (item) => item.wallet.ledgerAccountId === Number(selectedAccount?.accountId)
  );

  const agentIds = useMemo(() => new Set(agentAccountRows.map((a) => a.accountId)), [agentAccountRows]);

  // Keep historical GL amounts on the server. Only these customer-linked
  // display cards use the same operational balance as Factory Parties.
  const displayAccounts = useMemo(() => allAccounts.map(withPartyDisplayBalance), [allAccounts]);

  const agentAccounts = useMemo(() => {
    return displayAccounts.filter((a) => agentIds.has(a.id) && searchAny(agentSearch, a.name, a.code));
  }, [displayAccounts, agentIds, agentSearch]);

  const availableAccounts = useMemo(() => {
    return displayAccounts.filter((a) => !agentIds.has(a.id) && searchAny(addSearch, a.name, a.code, a.type));
  }, [displayAccounts, agentIds, addSearch]);

  const groupedVouchers = groupTransactions(transactions);

  const openingBalance: number = useMemo(
    () => computeOpeningBalance(selectedAccount, !!periodFilter.fromDate, prePeriodData),
    [periodFilter.fromDate, prePeriodData, selectedAccount]
  );

  const vouchersWithBalance = useMemo(
    () => computeRunningBalances(groupedVouchers, openingBalance, selectedAccount?.type),
    [groupedVouchers, openingBalance, selectedAccount]
  );

  const closingBalance = computeClosingBalance(vouchersWithBalance, openingBalance);
  const { periodDebit, periodCredit } = computePeriodTotals(vouchersWithBalance);

  const handlePeriodChange = useCallback((v: PeriodFilterValue) => setPeriodFilter(v), []);

  const handleExportExcel = async () => {
    if (!selectedAccount || vouchersWithBalance.length === 0) {
      toast({ title: "No data to export", variant: "destructive" });
      return;
    }
    // Include FX rate note when exporting in a converted currency.
    const fxNote =
      isMultiCurrency && displayCurrency && exchangeRate
        ? `Displayed in ${selectedCurrency}; 1 ${baseCurrency} = ${exchangeRate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${displayCurrency}`
        : null;
    // Load the spreadsheet implementation only when the user exports; it is not needed to open the ledger.
    const { buildAgentStatementExcelRows, exportAgentStatementExcel } = await import("./agents/agentStatementExcel");
    const rows = buildAgentStatementExcelRows({
      account: selectedAccount,
      vouchersWithBalance,
      openingBalance,
      formatAmount,
      fxNote: selectedFxWallet
        ? `Agent native balance: EUR ${selectedFxWallet.state.eur}; USD ${selectedFxWallet.state.usd}; current USD equivalent ${selectedFxWallet.currentUsd ?? "rate missing"}. Historical voucher entries remain in USD.`
        : fxNote,
    });
    await exportAgentStatementExcel(selectedAccount, rows);
    toast({ title: "Exported successfully" });
  };

  const handleAddAgent = (account: Account) => {
    addMutation.mutate(account);
  };

  const listPanel = (
    <div
      className={
        isPhone ? "flex w-full min-w-0 flex-col gap-2" : "flex w-80 shrink-0 min-w-0 flex-col gap-2 max-md:w-full"
      }
      data-testid="agent-list-column"
    >
      {(accountsError || agentsError) && (
        <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/5 p-3 text-sm">
          Unable to load some agent accounts. Check the connection and retry.
          <button
            type="button"
            className="ml-2 font-semibold underline"
            onClick={() => {
              if (accountsError) void retryAccounts();
              if (agentsError) void retryAgents();
            }}
          >
            Retry
          </button>
        </div>
      )}
      <AgentListPanel
        agentAccounts={agentAccounts}
        hasAnyAgents={agentIds.size > 0}
        loading={agentsLoading || accountsLoading}
        search={agentSearch}
        onSearchChange={setAgentSearch}
        selectedAccountId={selectedAccount?.id ?? null}
        onSelect={setSelectedAccount}
        onRemove={(accountId) => removeMutation.mutate(accountId)}
        formatAmount={formatAmount}
        onOpenAddDialog={() => {
          setAddSearch("");
          setAddDialogOpen(true);
        }}
        phone={isPhone}
      />
    </div>
  );
  const statementPanel = selectedAccount ? (
    <Suspense
      fallback={
        <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground" role="status">
          Opening agent statement…
        </div>
      }
    >
      <AgentStatementPanel
        companyName={selectedCompany?.name}
        selectedAccount={selectedAccount}
        fxWallet={selectedFxWallet}
        periodFilter={periodFilter}
        onPeriodChange={handlePeriodChange}
        transactionsLoading={transactionsLoading}
        vouchersWithBalance={vouchersWithBalance}
        openingBalance={openingBalance}
        periodDebit={periodDebit}
        periodCredit={periodCredit}
        closingBalance={closingBalance}
        onExportExcel={handleExportExcel}
        onClearAccount={() => setSelectedAccount(null)}
        formatAmount={formatAmount}
        formatDisplayDate={formatDisplayDate}
        phone={isPhone}
      />
    </Suspense>
  ) : null;
  const addDialog = addDialogOpen ? (
    <Suspense fallback={null}>
      <AddAgentDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        search={addSearch}
        onSearchChange={setAddSearch}
        availableAccounts={availableAccounts}
        loading={accountsLoading}
        formatAmount={formatAmount}
        onAdd={handleAddAgent}
      />
    </Suspense>
  ) : null;

  // Phones show one screen at a time: the agent list, then the selected agent's statement.
  if (isPhone) {
    return (
      <div className="flex min-w-0 flex-col gap-3 bg-slate-50/50 dark:bg-[#071225]" data-testid="agents-phone-layout">
        {statementPanel ?? listPanel}
        {addDialog}
      </div>
    );
  }

  return (
    // Below md the panes stack: the list is a bounded pane above the statement.
    <div className="flex h-full min-w-0 gap-3 bg-slate-50/70 p-3 dark:bg-[#071225] max-md:h-auto max-md:min-h-full max-md:flex-col max-md:overflow-visible max-md:p-0">
      {/* ── Left panel — agent list ─────────────────────────────────────── */}
      {listPanel}

      {/* ── Right panel — statement ─────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-y-auto max-md:w-full max-md:overflow-visible">
        {!selectedAccount ? (
          <div className="flex h-full min-h-72 items-center justify-center rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-blue-400/20 dark:bg-[#07152b]">
            <div className="flex max-w-xs flex-col items-center gap-4 px-4 text-center">
              <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-blue-300">
                <BookOpen className="h-8 w-8" />
              </div>
              <div>
                <p className="text-base font-semibold">No agent selected</p>
                <p className="text-sm text-muted-foreground mt-1">
                  Pick an agent from the list to view their ledger statement
                </p>
              </div>
            </div>
          </div>
        ) : (
          statementPanel
        )}
      </div>

      {/* ── Add account dialog ──────────────────────────────────────────── */}
      {addDialog}
    </div>
  );
}
