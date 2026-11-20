/**
 * Splitting an amount across lines to the cent, and the USD amount a daybook
 * entry stores (server/lib/money.ts).
 *
 * allocateCents spreads charges and settlements over lines; its shares must
 * always add back to the total, never overshoot and never go negative.
 * daybookAmountUsd decides what the amount_usd column holds.
 */
import { describe, expect, it } from "vitest";

import { allocateCents, daybookAmountUsd, moneyString, signedOpeningBalance, toMoney } from "../server/lib/money";

const strings = (values: { toFixed: (places: number) => string }[]) => values.map((value) => value.toFixed(2));

describe("allocateCents", () => {
  it("splits in proportion to the weights when it divides evenly", () => {
    expect(strings(allocateCents([1, 1, 2], "100"))).toEqual(["25.00", "25.00", "50.00"]);
  });

  it("gives leftover cents to the shares that lost the most in the cut", () => {
    // 10.00 over weights 1:1:1 is 3.333… each; the one spare cent goes to the first.
    expect(strings(allocateCents([1, 1, 1], "10"))).toEqual(["3.34", "3.33", "3.33"]);
    // 1.00 over 1:2:3: exact 0.1666…, 0.3333…, 0.5; cut to 0.16, 0.33, 0.50 leaves one cent,
    // which goes to the first (largest remainder 0.0066…), not the second (0.0033…).
    expect(strings(allocateCents([1, 2, 3], "1"))).toEqual(["0.17", "0.33", "0.50"]);
    // Weights 3:1 over 0.03: exact 0.0225 and 0.0075. The cut leaves 0.02 and 0.00, and the
    // spare cent goes to the second share, whose remainder (0.0075) is the larger.
    expect(strings(allocateCents([3, 1], "0.03"))).toEqual(["0.02", "0.01"]);
  });

  it("breaks equal remainders by line order", () => {
    expect(strings(allocateCents([1, 1, 1, 1], "0.02"))).toEqual(["0.01", "0.01", "0.00", "0.00"]);
  });

  it("always adds back to the total exactly", () => {
    for (const [weights, total] of [
      [[3, 7, 11], "123.45"],
      [[1, 1, 1, 1, 1, 1, 1], "100"],
      [["0.333", "0.333", "0.334"], "9999.99"],
    ] as const) {
      const shares = allocateCents(weights, total);
      expect(shares.reduce((sum, share) => sum.plus(share), toMoney(0)).toFixed(2)).toBe(toMoney(total).toFixed(2));
      expect(shares.every((share) => !share.isNegative())).toBe(true);
    }
  });

  it("splits a negative total the same way, with the sign restored", () => {
    expect(strings(allocateCents([1, 1, 1], "-10"))).toEqual(["-3.34", "-3.33", "-3.33"]);
  });

  it("ignores negative weights and gives everything to the first line when no weight is positive", () => {
    expect(strings(allocateCents([-5, 1, 1], "10"))).toEqual(["0.00", "5.00", "5.00"]);
    expect(strings(allocateCents([0, 0], "7.5"))).toEqual(["7.50", "0.00"]);
    expect(strings(allocateCents([-1, "bad"], "7.5"))).toEqual(["7.50", "0.00"]);
  });

  it("rounds the total to cents first, and returns nothing for no lines", () => {
    expect(strings(allocateCents([1], "10.005"))).toEqual(["10.01"]);
    expect(allocateCents([], "10")).toEqual([]);
  });
});

describe("daybookAmountUsd", () => {
  it("keeps the caller's own USD amount when given", () => {
    expect(daybookAmountUsd("EUR", 100, 1.1, 120.5)).toBe("120.5");
    expect(daybookAmountUsd("USD", 100, 1, 0)).toBe("0");
  });

  it("stores a USD amount as given", () => {
    expect(daybookAmountUsd("USD", 42.5, 99, undefined)).toBe("42.5");
  });

  it("multiplies exactly and keeps cents, where the float product used to round down", () => {
    expect(daybookAmountUsd("EUR", 1.13, 1.5, undefined)).toBe("1.70");
    expect(daybookAmountUsd("CFA", 10000, 0.0016, undefined)).toBe("16.00");
  });

  it("keeps a non-finite product as text instead of zeroing it", () => {
    expect(daybookAmountUsd("EUR", Number.NaN, 1.5, undefined)).toBe("NaN");
    expect(daybookAmountUsd("EUR", 2, Number.POSITIVE_INFINITY, undefined)).toBe("Infinity");
  });
});

describe("toMoney, opening balances and stored strings", () => {
  it("reads missing and empty input as zero", () => {
    for (const value of [null, undefined, ""]) expect(toMoney(value).toFixed(2)).toBe("0.00");
  });

  it("reads a number with a unit the way parseFloat does", () => {
    expect(toMoney("25 kg").toString()).toBe("25");
    expect(toMoney("abc").toString()).toBe("0");
  });

  it("signs an opening balance by its side, debit when the side is missing", () => {
    expect(signedOpeningBalance("50", "Cr").toString()).toBe("-50");
    expect(signedOpeningBalance("50", "Dr").toString()).toBe("50");
    expect(signedOpeningBalance("50", null).toString()).toBe("50");
    expect(signedOpeningBalance("50", "").toString()).toBe("50");
  });

  it("writes the two-decimal string a numeric(…, 2) column stores", () => {
    expect(moneyString("2.005")).toBe("2.01");
    expect(moneyString(null)).toBe("0.00");
  });
});
