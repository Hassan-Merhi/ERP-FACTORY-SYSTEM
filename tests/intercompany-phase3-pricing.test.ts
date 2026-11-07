import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import {
  allocateByWeights,
  exactNonnegativeRate,
  exactPositiveQuantity,
  fullPoCost,
  lineTotal,
  signedPair,
} from "../server/services/intercompany/tradeRevisionMath";

describe("Phase 3 atomic intercompany pricing and freight arithmetic", () => {
  it("extends quantity at exact USD cent precision with strict input validation", () => {
    expect(lineTotal("2.500", "12.40").toFixed(2)).toBe("31.00");
    expect(lineTotal("1.333", "0.25").toFixed(2)).toBe("0.33");
    expect(() => exactPositiveQuantity("0")).toThrow(/positive/);
    expect(() => exactPositiveQuantity("-1")).toThrow(/positive/);
    expect(() => exactPositiveQuantity("1.0001")).toThrow(/decimals/);
    expect(() => exactNonnegativeRate("-0.01")).toThrow(/non-negative/);
    expect(() => exactNonnegativeRate("1.234")).toThrow(/decimals/);
  });
  it("preserves external invoice totals and deterministically allocates rounding cents", () => {
    const three = allocateByWeights(new MoneyDecimal("100.01"), [
      new MoneyDecimal(1),
      new MoneyDecimal(1),
      new MoneyDecimal(1),
    ]);
    expect(three.map((x) => x.toFixed(2))).toEqual(["33.34", "33.34", "33.33"]);
    expect(three.reduce((a, b) => a.plus(b), new MoneyDecimal(0)).toFixed(2)).toBe("100.01");
    const zero = allocateByWeights(new MoneyDecimal(0), [new MoneyDecimal(5), new MoneyDecimal(2)]);
    expect(zero.map((x) => x.toFixed(2))).toEqual(["0.00", "0.00"]);
    expect(() => allocateByWeights(new MoneyDecimal("2.00"), [new MoneyDecimal(0), new MoneyDecimal(0)])).toThrow();
  });
  it("keeps landed cost in balance and never automatically reweights existing freight", () => {
    const po = {
      itemsTotal: "100.00",
      freight: "20.00",
      surcharge: "0",
      fumigation: "0",
      documentCharges: "0",
      discount: "2.00",
      otherCharges: "0",
    };
    expect(fullPoCost(po).toFixed(2)).toBe("118.00");
    expect(fullPoCost({ ...po, itemsTotal: "200.00" }).toFixed(2)).toBe("218.00");
    expect(po.freight).toBe("20.00");
  });
  it("posts positive and negative adjustments to precisely opposed accounts", () => {
    const increase = signedPair({ ledgerAccountId: 1 }, { supplierId: 2 }, new MoneyDecimal("150.00"), "Goods");
    expect(increase).toEqual([
      { ledgerAccountId: 1, debit: "150.00", narration: "Goods" },
      { supplierId: 2, credit: "150.00", narration: "Goods" },
    ]);
    const decrease = signedPair({ ledgerAccountId: 1 }, { supplierId: 2 }, new MoneyDecimal("-150.00"), "Goods");
    expect(decrease).toEqual([
      { supplierId: 2, debit: "150.00", narration: "Reversal: Goods" },
      { ledgerAccountId: 1, credit: "150.00", narration: "Reversal: Goods" },
    ]);
    expect(signedPair({ ledgerAccountId: 1 }, { supplierId: 2 }, new MoneyDecimal(0), "Goods")).toEqual([]);
    expect([...increase, ...decrease].every((x) => x.bankAccountId == null)).toBe(true);
  });
});
