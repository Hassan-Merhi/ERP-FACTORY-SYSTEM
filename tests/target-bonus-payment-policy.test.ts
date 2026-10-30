import { describe, expect, it } from "vitest";
import {
  isRealBonusDate,
  exactBonusCents,
  parseTargetBonusPaymentCommand,
  decideTargetBonusPaymentState,
} from "../server/services/factory/targetBonusPaymentPolicy";

const valid = {
  confirm: true,
  paymentDate: "2026-10-30",
  cashAccountId: 5,
  currency: "USD",
  selections: [
    { date: "2026-10-29", workerId: 8, expectedAmount: "3.50" },
    { date: "2026-10-29", workerId: 7, expectedAmount: "5.00" },
  ],
};

describe("Production Targets payout policy — phases 5+6", () => {
  it("accepts only real ISO calendar dates", () => {
    expect(isRealBonusDate("2026-10-29")).toBe(true);
    expect(isRealBonusDate("2026-02-29")).toBe(false);
    expect(isRealBonusDate("2024-02-29")).toBe(true);
    expect(isRealBonusDate("2026-13-01")).toBe(false);
    expect(isRealBonusDate("tomorrow")).toBe(false);
  });

  it("parses exact USD cents without binary float leakage", () => {
    expect(exactBonusCents("0.1")).toBe("0.10");
    expect(exactBonusCents("213.50")).toBe("213.50");
    expect(exactBonusCents("0")).toBeNull();
    expect(exactBonusCents("-1")).toBeNull();
    expect(exactBonusCents("1.001")).toBeNull();
    expect(exactBonusCents("NaN")).toBeNull();
  });

  it("requires explicit confirmation, a paying account and USD currency", () => {
    expect(() => parseTargetBonusPaymentCommand({ ...valid, confirm: false })).toThrow(/confirm/);
    expect(() => parseTargetBonusPaymentCommand({ ...valid, cashAccountId: 0 })).toThrow(/Cash or Bank/);
    expect(() => parseTargetBonusPaymentCommand({ ...valid, currency: "EUR" })).toThrow(/USD/);
  });

  it("rejects an empty batch and duplicate same-day worker selections", () => {
    expect(() => parseTargetBonusPaymentCommand({ ...valid, selections: [] })).toThrow(/between 1 and 100/);
    expect(() => parseTargetBonusPaymentCommand({
      ...valid, selections: [valid.selections[0], valid.selections[0]],
    })).toThrow(/Duplicate/);
  });

  it("sorts a complete batch predictably and locks expected amount", () => {
    const parsed = parseTargetBonusPaymentCommand(valid);
    expect(parsed.selections.map((r) => r.workerId)).toEqual([7, 8]);
    expect(parsed.selections[0].expectedAmount).toBe("5.00");
    expect(parsed.paymentDate).toBe("2026-10-30");
  });

  it("pays only approved amounts with no payroll collision", () => {
    expect(decideTargetBonusPaymentState("approved", "3.50", "3.50", false, false)).toBe("POST");
    expect(() => decideTargetBonusPaymentState("pending", "3.50", "3.50", false, false)).toThrow(/approved/);
    expect(() => decideTargetBonusPaymentState("rejected", "3.50", "3.50", false, false)).toThrow(/approved/);
    expect(() => decideTargetBonusPaymentState("approved", "3.50", "3.51", false, false)).toThrow(/changed/);
    expect(() => decideTargetBonusPaymentState("approved", "3.50", "3.50", false, true)).toThrow(/payroll/);
    expect(decideTargetBonusPaymentState("approved", "3.50", "3.50", true, false)).toBe("REPLAY");
  });

  it("rejects fractional-cent expected amounts and malformed selections", () => {
    expect(() => parseTargetBonusPaymentCommand({
      ...valid, selections: [{ date: "2026-10-29", workerId: 7, expectedAmount: "1.001" }],
    })).toThrow(/positive approved amount/);
    expect(() => parseTargetBonusPaymentCommand({
      ...valid, selections: [{ date: "2026-02-30", workerId: 7, expectedAmount: "1.00" }],
    })).toThrow(/positive approved amount/);
  });
});
