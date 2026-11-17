import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import {
  exactManualAllocation,
  oldestAvailableCredits,
  pairCreditBalance,
  paymentBaseAmount,
  paymentHistoricalRate,
  paymentMoney,
} from "../server/services/intercompany/paymentMoney";

describe("Phase 4 intercompany real payment and same-pair credit arithmetic", () => {
  it("accepts recorded USD and historical transaction-unit-per-USD currency rates only", () => {
    expect(paymentBaseAmount("USD", "100.00", "1").toFixed(2)).toBe("100.00");
    expect(paymentBaseAmount("CFA", "60500.00", "605.0000000000").toFixed(2)).toBe("100.00");
    expect(paymentBaseAmount("ZMW", "250.00", "25").toFixed(2)).toBe("10.00");
    expect(() => paymentHistoricalRate("CFA", "0")).toThrow();
    expect(() => paymentHistoricalRate("USD", "1.01")).toThrow(/identity/);
    expect(() => paymentMoney("12abc")).toThrow();
    expect(() => paymentMoney("-4")).toThrow();
    expect(() => paymentMoney("0")).toThrow();
  });
  it("saves excess actual cash as unallocated credit, never a fictitious cash posting", () => {
    expect(
      pairCreditBalance(new MoneyDecimal("120.00"), [new MoneyDecimal("40.00"), new MoneyDecimal("50.00")]).toFixed(2)
    ).toBe("30.00");
    expect(() => pairCreditBalance(new MoneyDecimal("10.00"), [new MoneyDecimal("11.00")])).toThrow();
  });
  it("automatically applies only oldest available credit to NEW imports", () => {
    const plan = oldestAvailableCredits(
      [
        { id: 1, available: new MoneyDecimal("5.00") },
        { id: 4, available: new MoneyDecimal("11.00") },
        { id: 5, available: new MoneyDecimal("7.00") },
      ],
      new MoneyDecimal("13.00")
    );
    expect(plan.map((a) => ({ paymentId: a.paymentId, amount: a.amount.toFixed(2) }))).toEqual([
      { paymentId: 1, amount: "5.00" },
      { paymentId: 4, amount: "8.00" },
    ]);
    expect(oldestAvailableCredits([{ id: 1, available: new MoneyDecimal("10") }], new MoneyDecimal("0"))).toEqual([]);
  });
  it("manual selection never overpays a chosen PO or moves excess out of its company pair", () => {
    exactManualAllocation(
      new MoneyDecimal("100"),
      [new MoneyDecimal("25.00"), new MoneyDecimal("50.00")],
      [new MoneyDecimal("25"), new MoneyDecimal("70")]
    );
    expect(() =>
      exactManualAllocation(new MoneyDecimal("100"), [new MoneyDecimal("50")], [new MoneyDecimal("40")])
    ).toThrow(/PO/);
    expect(() =>
      exactManualAllocation(new MoneyDecimal("10"), [new MoneyDecimal("15")], [new MoneyDecimal("100")])
    ).toThrow(/payment/);
  });
});
