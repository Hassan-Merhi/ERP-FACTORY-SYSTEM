// Extracted from ./useAnalyticsLegacy.tsx to keep that module under the source-size cap.
import type { Account, NetProfitAccount, NetProfitStatementData } from "./types";

export function isInventoryOnlyExpenseAccount(account: { code?: string | null; name?: string | null }): boolean {
  const code = (account.code || "").trim().toUpperCase();
  if (
    code === "INVENTORY" ||
    code === "STOCK_ADJUSTMENT" ||
    code === "PRODUCTION_ADJUSTMENT" ||
    code === "CONSUMPTION_EXPENSE"
  ) {
    return true;
  }

  const name = (account.name || "").trim().toLowerCase();
  return name === "credit note - customer return" || name === "stock adjustment (production/consumption)";
}

export type ExpensePeriodBreakdown = { accounts: NetProfitAccount[]; total: number };

export type ExpensePeriodResponse = { direct: ExpensePeriodBreakdown; indirect: ExpensePeriodBreakdown };

/** Keep the account hierarchy for period movements without using lifetime balances. */
export function withExpenseParents(section: ExpensePeriodBreakdown, allAccounts: Account[]): ExpensePeriodBreakdown {
  const ledgerAccounts = new Map(allAccounts.filter((a) => a.type === "ledger").map((a) => [a.accountId, a]));
  const rows = section.accounts
    .filter((a) => !isInventoryOnlyExpenseAccount(a))
    .map((a) => ({
      ...a,
      code: a.code ?? "",
      parentId: ledgerAccounts.get(a.id)?.parentId ?? undefined,
    }));
  const seen = new Set(rows.map((a) => a.id));
  for (const row of [...rows]) {
    if (!row.parentId || seen.has(row.parentId)) continue;
    const parent = ledgerAccounts.get(row.parentId);
    if (!parent) continue;
    rows.push({
      id: parent.accountId,
      code: parent.code ?? "",
      name: parent.name,
      debit: 0,
      credit: 0,
      balance: 0,
      parentId: parent.parentId ?? undefined,
    });
    seen.add(parent.accountId);
  }
  // The report total is the actual net postings, not the sum of absolute child balances.
  // If inventory-only rows slipped through, exclude their net amounts from the total.
  const excluded = section.accounts
    .filter((a) => isInventoryOnlyExpenseAccount(a))
    .reduce((sum, a) => sum + Number(a.balance || 0), 0);
  return { accounts: rows, total: Number(section.total) - excluded };
}

export function sanitizeNetProfitInventoryExpenses(data: NetProfitStatementData): NetProfitStatementData {
  const directAccounts = data.leftPane.directExpenses.accounts.filter((acc) => !isInventoryOnlyExpenseAccount(acc));
  const indirectAccounts = data.leftPane.indirectExpenses.accounts.filter((acc) => !isInventoryOnlyExpenseAccount(acc));

  const directTotal = directAccounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);
  const indirectTotal = indirectAccounts.reduce((sum, acc) => sum + Number(acc.balance || 0), 0);
  const removedDirect = data.leftPane.directExpenses.total - directTotal;
  const removedIndirect = data.leftPane.indirectExpenses.total - indirectTotal;

  return {
    ...data,
    leftPane: {
      ...data.leftPane,
      directExpenses: {
        ...data.leftPane.directExpenses,
        accounts: directAccounts,
        count: directAccounts.length,
        total: directTotal,
      },
      indirectExpenses: {
        ...data.leftPane.indirectExpenses,
        accounts: indirectAccounts,
        count: indirectAccounts.length,
        total: indirectTotal,
      },
      tradingTotal: data.leftPane.tradingTotal - removedDirect,
      grossProfit: data.leftPane.grossProfit + removedDirect,
      netProfit: data.leftPane.netProfit + removedDirect + removedIndirect,
    },
  };
}
