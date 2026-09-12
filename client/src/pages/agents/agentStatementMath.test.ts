/**
 * Unit tests for the Agent Ledger statement calculations extracted from
 * pages/Agents.tsx. These pin the accounting behaviour (supplier vs normal
 * side conventions, running/closing balances) so the split can't drift.
 */
import { describe, expect, it } from "vitest";
import {
  parseBalance,
  groupTransactions,
  computeOpeningBalance,
  computeRunningBalances,
  computeClosingBalance,
  computePeriodTotals,
  balanceSideLabel,
  type Account,
  type Transaction,
} from "./agentStatementMath";

function makeAccount(overrides: Partial<Account> = {}): Account {
  return {
    id: "acc-1",
    accountId: 1,
    type: "customer",
    code: "C-1",
    name: "Alpha",
    balance: 100,
    balanceSide: "Dr",
    openingBalance: 50,
    openingBalanceSide: "Dr",
    active: true,
    ...overrides,
  };
}

function makeTransaction(overrides: Partial<Transaction> = {}): Transaction {
  return {
    entryId: 1,
    voucherId: 10,
    debitAmount: "20",
    creditAmount: "0",
    narration: "sale",
    voucherNumber: "JV-10",
    voucherType: "Journal",
    voucherDate: "2026-08-20",
    voucherDescription: "desc",
    ...overrides,
  };
}

describe("parseBalance", () => {
  it("parses numeric strings and tolerates junk", () => {
    expect(parseBalance("12.5")).toBe(12.5);
    expect(parseBalance(7)).toBe(7);
    expect(parseBalance(null)).toBe(0);
    expect(parseBalance(undefined)).toBe(0);
    expect(parseBalance("")).toBe(0);
    expect(parseBalance("abc")).toBe(0);
  });
});

describe("groupTransactions", () => {
  it("aggregates debit/credit per voucher and sorts by date then number", () => {
    const grouped = groupTransactions([
      makeTransaction({
        voucherId: 20,
        debitAmount: "10",
        creditAmount: "0",
        voucherDate: "2026-08-22",
        voucherNumber: "B",
      }),
      makeTransaction({
        voucherId: 10,
        debitAmount: "30",
        creditAmount: "5",
        voucherDate: "2026-08-20",
        voucherNumber: "A",
      }),
      makeTransaction({
        voucherId: 10,
        debitAmount: "7",
        creditAmount: "2",
        voucherDate: "2026-08-20",
        voucherNumber: "A",
        narration: "second",
      }),
      makeTransaction({
        voucherId: 15,
        debitAmount: "0",
        creditAmount: "9",
        voucherDate: "2026-08-20",
        voucherNumber: "A",
      }),
    ]);

    expect(grouped).toHaveLength(3);
    expect(grouped[0]).toMatchObject({ voucherId: 10, totalDebit: 37, totalCredit: 7, narration: "desc" });
    expect(grouped[1]).toMatchObject({ voucherId: 15, totalDebit: 0, totalCredit: 9 });
    expect(grouped[2]).toMatchObject({ voucherId: 20, totalDebit: 10, totalCredit: 0 });
  });
});

describe("computeOpeningBalance", () => {
  it("prefers the pre-period balance when a from-date is set", () => {
    expect(computeOpeningBalance(makeAccount(), true, { balance: 25 })).toBe(25);
  });

  it("falls back to the account opening balance without a from-date", () => {
    expect(computeOpeningBalance(makeAccount(), false, undefined)).toBe(50);
    expect(computeOpeningBalance(makeAccount(), false, { balance: 25 })).toBe(50);
  });

  it("keeps the raw opening balance for supplier accounts", () => {
    expect(
      computeOpeningBalance(
        makeAccount({ type: "supplier", openingBalance: 50, openingBalanceSide: "Cr" }),
        false,
        undefined
      )
    ).toBe(50);
  });

  it("negates credit-side opening balances for non-supplier accounts", () => {
    expect(computeOpeningBalance(makeAccount({ openingBalanceSide: "Cr" }), false, undefined)).toBe(-50);
  });

  it("handles a missing account", () => {
    expect(computeOpeningBalance(null, false, undefined)).toBe(0);
  });
});

describe("computeRunningBalances / computeClosingBalance / computePeriodTotals", () => {
  const grouped = groupTransactions([
    makeTransaction({ voucherId: 1, debitAmount: "100", creditAmount: "0", voucherDate: "2026-08-01" }),
    makeTransaction({ voucherId: 2, debitAmount: "0", creditAmount: "40", voucherDate: "2026-08-02" }),
  ]);

  it("accumulates debit minus credit for non-supplier accounts", () => {
    const running = computeRunningBalances(grouped, 50, "customer");
    expect(running.map((v) => v.runningBalance)).toEqual([150, 110]);
    expect(computeClosingBalance(running, 50)).toBe(110);
    expect(computePeriodTotals(running)).toEqual({ periodDebit: 100, periodCredit: 40 });
  });

  it("accumulates credit minus debit for supplier accounts", () => {
    const running = computeRunningBalances(grouped, 50, "supplier");
    expect(running.map((v) => v.runningBalance)).toEqual([-50, -10]);
    expect(computeClosingBalance(running, 50)).toBe(-10);
    expect(computePeriodTotals(running)).toEqual({ periodDebit: 100, periodCredit: 40 });
  });

  it("returns the opening balance when there are no vouchers", () => {
    expect(computeClosingBalance([], 42)).toBe(42);
  });
});

describe("balanceSideLabel", () => {
  it("labels supplier balances Cr when positive and Dr when negative", () => {
    expect(balanceSideLabel(10, "supplier")).toBe("Cr");
    expect(balanceSideLabel(-10, "supplier")).toBe("Dr");
  });

  it("labels other account balances Dr when positive and Cr when negative", () => {
    expect(balanceSideLabel(10, "customer")).toBe("Dr");
    expect(balanceSideLabel(-10, "customer")).toBe("Cr");
  });
});
