/**
 * The profit-and-loss and balance-sheet services sum exactly: an expense
 * account debited 0.10 and 0.20 and credited 0.30 nets to zero and drops out
 * (the float residue 5.6e-17 kept it on the statement), and a ledger with
 * debits of 0.10 and 0.20 shows 0.30.
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

  it("sums ledger balances exactly on the balance sheet", async () => {
    results.push([
      { ledgerAccountId: 3, debitAmount: "0.10", creditAmount: "0" },
      { ledgerAccountId: 3, debitAmount: "0.20", creditAmount: "0" },
    ]);
    const sheet = await getBalanceSheet(7, undefined);

    expect(sheet.assets.ledgers).toEqual([{ id: 3, code: "CASH", name: "Cash", balance: 0.3 }]);
    expect(sheet.assets.total).toBe(0.3);
  });
});
