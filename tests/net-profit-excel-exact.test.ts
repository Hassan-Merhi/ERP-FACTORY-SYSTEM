/**
 * The net-profit workbook rounds and sums money exactly:
 * - a closing stock of 0.5 x 2.01 is written as 1.01 (the float path wrote 1);
 * - a 1.005 loss rounds half away from zero to -1.01, as Postgres does;
 * - entries of 0.1 and 0.2 sum to 0.3, not 0.30000000000000004.
 */
import { describe, expect, it } from "vitest";
import { computeBalancesFromEntries, fmt } from "../server/routes/netProfitExcelSheets";

describe("net profit workbook money", () => {
  it("rounds half-cent values half away from zero", () => {
    expect(fmt(0.5 * 2.01)).toBe(1.01);
    expect(fmt(-1.005)).toBe(-1.01);
    expect(fmt(0.1 + 0.2)).toBe(0.3);
  });

  it("sums ledger entries exactly", () => {
    const balances = computeBalancesFromEntries([
      { ledgerAccountId: 4, debitAmount: "0.1", creditAmount: "0" },
      { ledgerAccountId: 4, debitAmount: "0.2", creditAmount: "0.7" },
      { ledgerAccountId: 4, debitAmount: null, creditAmount: "0.1" },
    ]);
    expect(balances.get(4)).toEqual({ debit: 0.3, credit: 0.8 });
  });
});
