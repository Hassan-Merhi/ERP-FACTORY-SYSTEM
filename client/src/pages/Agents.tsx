/**
 * Agent Ledger page.
 *
 * Composes the agent list panel, the statement panel, and the add-account
 * dialog; data access lives in pages/agents/useAgentLedger.ts, statement
 * math in pages/agents/agentStatementMath.ts, and Excel export in
 * pages/agents/agentStatementExcel.ts. Behaviour is unchanged.
 */
import { useState, useCallback, useMemo } from "react";
import { useCompany } from "@/contexts/CompanyContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { BookOpen } from "lucide-react";
import { PeriodFilterValue, getDefaultPeriodValue } from "@/components/ui/period-filter";
import { useDateJump } from "@/hooks/use-date-jump";
import { useEscapeBack } from "@/hooks/use-escape-back";
import {
  groupTransactions,
  computeOpeningBalance,
  computeRunningBalances,
  computeClosingBalance,
  computePeriodTotals,
  type Account,
} from "./agents/agentStatementMath";
import { buildAgentStatementExcelRows, exportAgentStatementExcel } from "./agents/agentStatementExcel";
import { useAgentLedger } from "./agents/useAgentLedger";
import { AgentListPanel } from "./agents/AgentListPanel";
import { AgentStatementPanel } from "./agents/AgentStatementPanel";
import { AddAgentDialog } from "./agents/AddAgentDialog";

export default function Agents() {
  const { selectedCompany } = useCompany();
  const { formatAmount, selectedCurrency, exchangeRate, isMultiCurrency } = useCurrencyContext();
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilterValue>(() => getDefaultPeriodValue("today"));
  useDateJump((date) => setPeriodFilter({ fromDate: date, toDate: date, preset: "custom" }));
  const [agentSearch, setAgentSearch] = useState("");
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const [addSearch, setAddSearch] = useState("");

  useEscapeBack(selectedAccount ? () => setSelectedAccount(null) : null);

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

  const agentIds = useMemo(() => new Set(agentAccountRows.map((a) => a.accountId)), [agentAccountRows]);

  const agentAccounts = useMemo(() => {
    const searchLower = agentSearch.trim().toLowerCase();
    return allAccounts.filter((a) => {
      if (!agentIds.has(a.id)) return false;
      if (searchLower && !a.name.toLowerCase().includes(searchLower) && !a.code.toLowerCase().includes(searchLower))
        return false;
      return true;
    });
  }, [allAccounts, agentIds, agentSearch]);

  const availableAccounts = useMemo(() => {
    const searchLower = addSearch.trim().toLowerCase();
    return allAccounts.filter((a) => {
      if (agentIds.has(a.id)) return false;
      if (
        searchLower &&
        !a.name.toLowerCase().includes(searchLower) &&
        !a.code.toLowerCase().includes(searchLower) &&
        !a.type.toLowerCase().includes(searchLower)
      )
        return false;
      return true;
    });
  }, [allAccounts, agentIds, addSearch]);

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
      isMultiCurrency && exchangeRate
        ? `${selectedCurrency} @ rate ${exchangeRate.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} per USD`
        : null;
    const rows = buildAgentStatementExcelRows({
      account: selectedAccount,
      vouchersWithBalance,
      openingBalance,
      formatAmount,
      fxNote,
    });
    await exportAgentStatementExcel(selectedAccount, rows);
    toast({ title: "Exported successfully" });
  };

  const handleAddAgent = (account: Account) => {
    addMutation.mutate(account);
  };

  return (
    <div className="flex h-full">
      {/* ── Left panel — agent list ─────────────────────────────────────── */}
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
      />

      {/* ── Right panel — statement ─────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto bg-background">
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
          <AgentStatementPanel
            companyName={selectedCompany?.name}
            selectedAccount={selectedAccount}
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
          />
        )}
      </div>

      {/* ── Add account dialog ──────────────────────────────────────────── */}
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
    </div>
  );
}
