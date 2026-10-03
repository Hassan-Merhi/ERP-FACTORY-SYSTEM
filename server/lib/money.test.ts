import { describe, expect, it } from "vitest";
import { debitMinusCredit, moneyString, signedOpeningBalance, sumMoney, toMoney } from "./money";

describe("money helpers", () => {
  it("sums exactly where floats drift", () => {
    const values = Array.from({ length: 10 }, () => "0.10");
    expect(values.reduce((sum, value) => sum + parseFloat(value), 0)).not.toBe(1);
    expect(sumMoney(values).toFixed(2)).toBe("1.00");
    expect(sumMoney(["0.1", "0.2"]).eq("0.3")).toBe(true);
  });

  it("treats empty, invalid and non-finite input as zero", () => {
    for (const value of [null, undefined, "", "abc", Infinity, Number.NaN]) {
      expect(toMoney(value).isZero()).toBe(true);
    }
  });

  it("nets ledger lines and signs opening balances", () => {
    expect(
      debitMinusCredit([
        { debitAmount: "100.10", creditAmount: "0" },
        { debitAmount: null, creditAmount: "0.20" },
      ]).toFixed(2)
    ).toBe("99.90");
    expect(signedOpeningBalance("40", "Cr").toFixed(2)).toBe("-40.00");
    expect(signedOpeningBalance("40", null).toFixed(2)).toBe("40.00");
  });

  it("rounds to cents half up for storage", () => {
    expect(moneyString("1.005")).toBe("1.01");
    expect(moneyString("-1.005")).toBe("-1.01");
    expect(moneyString(null)).toBe("0.00");
  });
});
