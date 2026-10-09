/**
 * Money helpers for allocations and line amounts, and the Supplier Partner
 * POS deduction, computed in exact decimals. Float products rounded with
 * toFixed(2) gave 3 x 1.115 = 3.34 instead of 3.35, and scaling journal lines
 * one by one could leave a voucher's debits and credits a cent apart.
 */
import { describe, expect, it } from "vitest";

import { allocateCents, lineAmount } from "../server/lib/money";
import { saleTotalCents, spDeductionAmount, spPayableAfterDeduction } from "../server/services/pos/spDeduction";

describe("allocateCents", () => {
  it("splits a total so the parts add up to it exactly", () => {
    const parts = allocateCents(["1", "1", "1"], "100");
    expect(parts.map((part) => part.toFixed(2))).toEqual(["33.34", "33.33", "33.33"]);
    expect(parts.reduce((sum, part) => sum.plus(part), parts[0].minus(parts[0])).toFixed(2)).toBe("100.00");
  });

  it("rescales lines in proportion and puts the leftover cent on the largest", () => {
    const parts = allocateCents(["60.00", "30.00", "10.00"], "33.33");
    expect(parts.map((part) => part.toFixed(2))).toEqual(["20.00", "10.00", "3.33"]);
  });

  it("gives the whole total to the first line when no weight is positive", () => {
    expect(allocateCents(["0", "0"], "5").map((part) => part.toFixed(2))).toEqual(["5.00", "0.00"]);
    expect(allocateCents([], "5")).toEqual([]);
  });
});

describe("lineAmount", () => {
  it("multiplies exactly, so rounding once gives 3.35", () => {
    expect(lineAmount(3, 1.115).toFixed(2)).toBe("3.35");
    expect((3 * 1.115).toFixed(2)).toBe("3.34");
  });
});

describe("Supplier Partner POS deduction", () => {
  it("takes 3 x 1.115 as 3.35 and the payable as the exact remainder", () => {
    expect(spDeductionAmount(3, 1.115)).toBe(3.35);
    expect(spPayableAfterDeduction(saleTotalCents(10), spDeductionAmount(3, 1.115))).toBe(6.65);
  });

  it("rounds the sale total once from its exact value", () => {
    expect(saleTotalCents(1.005)).toBe(1.01);
  });
});
