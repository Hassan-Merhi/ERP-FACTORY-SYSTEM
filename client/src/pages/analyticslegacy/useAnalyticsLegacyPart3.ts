// Extracted from ./useAnalyticsLegacy.tsx to keep that module under the source-size cap.
import { calculatePLTotal, isVisibleAnalyticsAssetAccount } from "./accountMath";
import { useAccountRenderers } from "./useAccountRenderers";
import { isInventoryOnlyExpenseAccount } from "./useAnalyticsLegacyWithExpenseParents";
import { useAnalyticsLegacyPart1 } from "./useAnalyticsLegacyPart1";

export function useAnalyticsLegacyPart3({
  accounts,
  accountsLoading,
  appMode,
  expandedAccounts,
  navigate,
  setExpandedAccounts,
}: Pick<
  Awaited<ReturnType<typeof useAnalyticsLegacyPart1>>,
  "accounts" | "accountsLoading" | "appMode" | "expandedAccounts" | "navigate" | "setExpandedAccounts"
>) {
  // Helper functions
  const toggleAccount = (accountId: number) => {
    const newExpanded = new Set(expandedAccounts);
    if (newExpanded.has(accountId)) {
      newExpanded.delete(accountId);
    } else {
      newExpanded.add(accountId);
    }
    setExpandedAccounts(newExpanded);
  };

  // Filter accounts - Cash accounts are ledger accounts with accountType="Cash"
  // Also include bank-entity accounts whose name/code contains "cash"
  const cashAccounts = accounts.filter(
    (acc) =>
      (acc.type === "ledger" && acc.accountType === "Cash") ||
      (acc.type === "bank" &&
        ((acc.name || "").toLowerCase().includes("cash") || (acc.code || "").toLowerCase().includes("cash")))
  );

  // Ledger accounts typed as "Bank" (e.g. "Roukaya Cash") — shown in Loans/Banks section
  // These are separate from bank-entity accounts (acc.type === "bank")
  const bankTypeLedgerAccounts = accounts.filter((acc) => acc.type === "ledger" && acc.accountType === "Bank");

  // Analytics Assets is a management display: don't present inventory control
  // or SP profit correction suspense as usable assets. Ledger/API stay intact.
  const assetAccounts = accounts.filter(isVisibleAnalyticsAssetAccount);

  // Include all expense accounts in P&L calculations (no exclusions)
  const expenseAccounts = accounts.filter((acc) => {
    if (acc.type !== "ledger") return false;

    // Support both correct format (accountType="Expense") and legacy format
    // (accountType="Indirect Expense" or "Direct Expense")
    const isExpenseAccount =
      acc.accountType === "Expense" || acc.accountType === "Indirect Expense" || acc.accountType === "Direct Expense";

    return isExpenseAccount && !isInventoryOnlyExpenseAccount(acc);
  });

  const directExpenseAccounts = expenseAccounts.filter(
    (acc) => acc.subType === "Direct Expense" || acc.accountType === "Direct Expense"
  );

  const indirectExpenseAccounts = expenseAccounts.filter(
    (acc) => acc.subType === "Indirect Expense" || acc.accountType === "Indirect Expense"
  );

  const liabilityAccounts = accounts.filter(
    (acc) =>
      acc.type === "ledger" &&
      // Exclude per-worker insurance liability accounts ("Insurance - [name]").
      // These belong to the Insurance section, not the balance-sheet liabilities list.
      !/^Insurance\s*[-–]/i.test(acc.name) &&
      (acc.accountType === "Liability" ||
        acc.accountType === "Accounts Payable" ||
        acc.accountType === "Loans" ||
        acc.accountType === "Duty Agent" ||
        acc.accountType === "Transporter Agent")
  );

  const loansBanksAccounts = accounts.filter(
    (acc) =>
      acc.type === "bank" || (acc.type === "ledger" && (acc.accountType === "Loans" || acc.accountType === "Bank"))
  );

  const directIncomeAccounts = accounts.filter(
    (acc) => acc.type === "ledger" && acc.accountType === "Income" && acc.subType === "Direct Income"
  );

  const indirectIncomeAccounts = accounts.filter(
    (acc) => acc.type === "ledger" && acc.accountType === "Income" && acc.subType === "Indirect Income"
  );

  // P&L calculations
  const totalDirectIncome = calculatePLTotal(directIncomeAccounts);
  const totalIndirectIncome = calculatePLTotal(indirectIncomeAccounts);
  const totalIncome = totalDirectIncome + totalIndirectIncome;
  const totalDirectExpense = Math.abs(calculatePLTotal(directExpenseAccounts));
  const totalIndirectExpense = Math.abs(calculatePLTotal(indirectExpenseAccounts));
  const totalExpenses = totalDirectExpense + totalIndirectExpense;

  // Render hierarchical NetProfitAccounts (groups collapse/expand)

  const netProfit = totalIncome - totalExpenses;

  const goToStatement = (accountId: number, customerId?: number, _accountType?: string) => {
    if (customerId && appMode === "factory") {
      window.open(`/factory/customers/${customerId}`, "_blank");
      return;
    }
    if (appMode === "factory") {
      // Same-tab SPA navigation keeps the factory session/company context intact.
      // window.open(_blank) opens a fresh tab without factory context → guard
      // redirects to home.
      navigate(`/factory/accounts?accountId=${accountId}&accountType=ledger`);
      return;
    }
    window.open(`/ledger-monthly/${accountId}`, "_blank");
  };

  const { renderNetProfitAccountsList, renderHierarchicalAccounts, renderPLAccountTable } = useAccountRenderers({
    accountsLoading,
    appMode,
    expandedAccounts,
    navigate,
    goToStatement,
    toggleAccount,
    totalExpenses,
    totalIncome,
  });
  return {
    assetAccounts,
    bankTypeLedgerAccounts,
    cashAccounts,
    directExpenseAccounts,
    directIncomeAccounts,
    expenseAccounts,
    goToStatement,
    indirectExpenseAccounts,
    indirectIncomeAccounts,
    liabilityAccounts,
    loansBanksAccounts,
    netProfit,
    renderHierarchicalAccounts,
    renderNetProfitAccountsList,
    renderPLAccountTable,
    toggleAccount,
    totalDirectExpense,
    totalDirectIncome,
    totalExpenses,
    totalIncome,
    totalIndirectExpense,
    totalIndirectIncome,
  };
}
