import { searchAny } from "@shared/searchNormalization";
/**
 * Agent Ledger page.
 *
 * Composes the agent list panel, the statement panel, and the add-account
 * dialog; data access lives in pages/agents/useAgentLedger.ts, statement
 * math in pages/agents/agentStatementMath.ts, and Excel export in
 * pages/agents/agentStatementExcel.ts. Behaviour is unchanged.
 */
import { useState, useCallback, useMemo } from "react";
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
import { buildAgentStatementExcelRows, exportAgentStatementExcel } from "./agents/agentStatementExcel";
import { useAgentLedger } from "./agents/useAgentLedger";
import { AgentListPanel } from "./agents/AgentListPanel";
import { AgentStatementPanel } from "./agents/AgentStatementPanel";
import { AddAgentDialog } from "./agents/AddAgentDialog";

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
  );
  const statementPanel = selectedAccount ? (
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
  ) : null;
  const addDialog = (
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
  );

  // Phones show one screen at a time: the agent list, then the selected agent's statement.
  if (isPhone) {
    return (
      <div className="flex min-w-0 flex-col gap-3" data-testid="agents-phone-layout">
        {statementPanel ?? listPanel}
        {addDialog}
      </div>
    );
  }

  return (
    // Below md the panes stack: the list is a bounded pane above the statement.
    <div className="flex h-full max-md:h-auto max-md:min-h-full max-md:flex-col max-md:overflow-visible">
      {/* ── Left panel — agent list ─────────────────────────────────────── */}
      {listPanel}

      {/* ── Right panel — statement ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-background max-md:w-full max-md:min-w-0 max-md:overflow-visible">
        {!selectedAccount ? (
          <div className="h-full flex items-center justify-center">
            <div className="flex flex-col items-center gap-4 text-center max-w-xs">
              <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center">
                <BookOpen className="h-8 w-8 text-muted-foreground" />
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
