import { describe, expect, it } from "vitest";

import { hierarchicalAccountRows, netProfitAccountRows } from "./analyticsExportRows";
import type { NetProfitAccount } from "./types";

type AccountInput = Parameters<typeof hierarchicalAccountRows>[0][number];

const ledger = (
  accountId: number,
  name: string,
  balance: number,
  balanceSide: "Dr" | "Cr",
  parentId?: number
): AccountInput => ({
  id: `ledger-${accountId}`,
  accountId,
  type: "ledger",
  code: `L${accountId}`,
  name,
  balance,
  balanceSide,
  active: true,
  parentId,
});

describe("Analytics export rows", () => {
  const accounts = [
    ledger(1, "Receivables", 0, "Dr"),
    ledger(2, "Customer A", 300, "Dr", 1),
    ledger(3, "Customer B", 50, "Cr", 1),
    ledger(4, "Customer C", 0, "Dr", 1),
    ledger(5, "Petty cash", 20, "Dr"),
    ledger(6, "Dormant", 0, "Dr"),
  ];

  it("lists collapsed groups as one rolled-up row and hides zero-balance accounts", () => {
    expect(hierarchicalAccountRows(accounts, new Set())).toEqual([
      { name: "Receivables", depth: 0, balance: 250 },
      { name: "Petty cash", depth: 0, balance: 20 },
    ]);
  });

  it("adds the visible children of an expanded group under it", () => {
    expect(hierarchicalAccountRows(accounts, new Set([1]))).toEqual([
      { name: "Receivables", depth: 0, balance: 250 },
      { name: "Customer A", depth: 1, balance: 300 },
      { name: "Customer B", depth: 1, balance: -50 },
      { name: "Petty cash", depth: 0, balance: 20 },
    ]);
  });

  it("rolls payroll children into their group and keeps zero-activity payroll workers", () => {
    const expenses: NetProfitAccount[] = [
      { id: 10, code: "SW", name: "Salary Expense - Workers", debit: 0, credit: 0, balance: 0 },
      { id: 11, code: "W1", name: "Worker One", debit: 100, credit: 0, balance: 100, parentId: 10 },
      { id: 12, code: "W2", name: "Worker Two", debit: 0, credit: 0, balance: 0, parentId: 10 },
      { id: 13, code: "RENT", name: "Rent", debit: 40, credit: 10, balance: 30 },
      { id: 14, code: "IDLE", name: "Idle", debit: 0, credit: 0, balance: 0 },
    ];
    // Same order as the panel: accounts with activity first, then group rows added for their children.
    expect(netProfitAccountRows(expenses, new Set())).toEqual([
      { name: "Rent", depth: 0, balance: 30 },
      { name: "Salary Expense - Workers", depth: 0, balance: 100 },
    ]);
    expect(netProfitAccountRows(expenses, new Set([10]))).toEqual([
      { name: "Rent", depth: 0, balance: 30 },
      { name: "Salary Expense - Workers", depth: 0, balance: 100 },
      { name: "Worker One", depth: 1, balance: 100 },
      { name: "Worker Two", depth: 1, balance: 0 },
    ]);
  });
});
