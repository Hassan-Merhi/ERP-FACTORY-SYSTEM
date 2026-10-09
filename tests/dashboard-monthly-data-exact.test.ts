/**
 * The dashboard's monthly sales and profit are exact: two sales of 0.10
 * and 0.20 in a month are 0.30 (the float sum was 0.30000000000000004).
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
      { id: 1, code: "SALES", name: "Sales", accountType: "Income" },
      { id: 2, code: "RENT", name: "Rent", accountType: "Expense" },
    ],
  },
}));

import { getMonthlyData } from "../server/services/stats/dashboardStatsService";

describe("dashboard monthly data", () => {
  it("sums sales and profit exactly", async () => {
    const today = new Date().toISOString().slice(0, 10);
    results.push(
      [
        { voucherDate: today, totalAmount: "0.10" },
        { voucherDate: today, totalAmount: "0.20" },
      ],
      [
        { voucherId: 1, voucherDate: today, ledgerAccountId: 1, debitAmount: "0", creditAmount: "0.10" },
        { voucherId: 2, voucherDate: today, ledgerAccountId: 1, debitAmount: "0", creditAmount: "0.20" },
        { voucherId: 3, voucherDate: today, ledgerAccountId: 2, debitAmount: "0.70", creditAmount: "0" },
      ]
    );

    const months = await getMonthlyData(7);
    const current = months[months.length - 1];

    expect(current.sales).toBe(0.3);
    expect(current.profit).toBe(-0.4);
  });
});
