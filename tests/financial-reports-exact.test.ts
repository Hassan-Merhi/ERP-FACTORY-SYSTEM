/**
 * The profit-and-loss and balance-sheet services sum exactly: an expense
 * account debited 0.10 and 0.20 and credited 0.30 nets to zero and drops out
 * (the float residue 5.6e-17 kept it on the statement), and the balance sheet
 * (built on the trial balance since wave 9) carries its exact closing balances.
 */
import { describe, expect, it, vi } from "vitest";

const results: unknown[][] = [];
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin"]) q[step] = () => q;
    q.execute = async () => results.shift() ?? [];
    return q;
  };
  return { db: { select: () => chain() } };
});
vi.mock("../server/storage", () => ({
  storage: {
    getAllLedgerAccounts: async () => [
      { id: 1, code: "RENT", name: "Rent", accountType: "Expense", openingBalance: "0" },
      { id: 2, code: "SALES", name: "Sales", accountType: "Income", openingBalance: "0" },
      { id: 3, code: "CASH", name: "Cash", accountType: "Asset", openingBalance: "0" },
    ],
    getAllBankAccounts: async () => [],
    getAllFixedAssets: async () => [],
    getAllEmployees: async () => [],
    getAllSuppliers: async () => [],
  },
}));

const trialBalanceRows: unknown[] = [];
vi.mock("../server/services/accounting/integrity/trialBalance", () => ({
  buildTrialBalance: async () => ({ rows: trialBalanceRows }),
}));

import { getBalanceSheet, getProfitLoss } from "../server/services/reports/financialReportsService";

describe("financial reports", () => {
  it("drops an expense account whose entries cancel exactly", async () => {
    results.push([
      { ledgerAccountId: 1, debitAmount: "0.10", creditAmount: "0" },
      { ledgerAccountId: 1, debitAmount: "0.20", creditAmount: "0" },
      { ledgerAccountId: 1, debitAmount: "0", creditAmount: "0.30" },
      { ledgerAccountId: 2, debitAmount: "0", creditAmount: "0.30" },
    ]);
    const pl = await getProfitLoss(7, undefined, undefined);

    expect(pl.expenseItems).toEqual([]);
    expect(pl.totalIncome).toBe(0.3);
    expect(pl.netProfit).toBe(0.3);
  });

  it("carries the trial balance's exact closing balances on the balance sheet", async () => {
    const row = (id: number, code: string, accountType: string, closingDebit: string, closingCredit: string) => ({
      kind: "ledger",
      id,
      code,
      name: code,
      accountType,
      deleted: false,
      closingDebit,
      closingCredit,
    });
    trialBalanceRows.push(
      row(3, "CASH", "Cash", "0.30", "0.00"),
      row(4, "CAPITAL", "Equity", "0.00", "0.10"),
      row(2, "SALES", "Income", "0.00", "0.20")
    );
    const sheet = await getBalanceSheet(7, undefined);

    expect(sheet.assets.total).toBe("0.30");
    expect(sheet.equity).toMatchObject({ currentEarnings: "0.20", total: "0.30" });
    expect(sheet.difference).toBe("0.00");
    expect(sheet.balanced).toBe(true);
  });
});
