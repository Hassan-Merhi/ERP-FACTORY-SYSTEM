import { describe, expect, it } from "vitest";
import {
  applyFxUsdAdjustmentOverrides,
  normalizeFxUsdAdjustment,
  FxUsdAdjustmentOverrideError,
} from "../server/services/accounting/fxCorrectionAmountOverrides";

const lines = [
  { accountKind: "ledger" as const, accountId: 10, accountName: "CASH", currency: "CFA", adjustmentUsd: "-2520.83" },
  { accountKind: "customer" as const, accountId: 14, accountName: "Habiba", currency: "CFA", adjustmentUsd: "-328.14" },
];

describe("Admin FX correction amount overrides", () => {
  it("limits edits to verified source accounts and preserves their currency and name", () => {
    const revised = applyFxUsdAdjustmentOverrides(lines, [
      { accountKind: "ledger", accountId: 10, adjustmentUsd: "-1500.25" },
    ]);
    expect(revised[0]).toMatchObject({
      accountName: "CASH", currency: "CFA",
      automaticAdjustmentUsd: "-2520.83", adjustmentUsd: "-1500.25",
      manuallyOverridden: true,
    });
    expect(revised[1].manuallyOverridden).toBe(false);
  });
  it("supports exact cents, sign changes and zero without floating point rounding", () => {
    expect(normalizeFxUsdAdjustment("-12.3")).toBe("-12.30");
    expect(normalizeFxUsdAdjustment("0.00")).toBe("0.00");
    expect(applyFxUsdAdjustmentOverrides(lines, [
      { accountKind: "ledger", accountId: 10, adjustmentUsd: "15.01" },
      { accountKind: "customer", accountId: 14, adjustmentUsd: "0" },
    ]).map(l => l.adjustmentUsd)).toEqual(["15.01", "0.00"]);
  });
  it("rejects unverified accounts, repeated accounts and spoofed account kinds", () => {
    expect(() => applyFxUsdAdjustmentOverrides(lines, [
      { accountKind: "bank", accountId: 10, adjustmentUsd: "-1.00" },
    ])).toThrow(FxUsdAdjustmentOverrideError);
    expect(() => applyFxUsdAdjustmentOverrides(lines, [
      { accountKind: "ledger", accountId: 10, adjustmentUsd: "-1.00" },
      { accountKind: "ledger", accountId: 10, adjustmentUsd: "-2.00" },
    ])).toThrow(FxUsdAdjustmentOverrideError);
  });
  it("refuses fractional cents, exponent notation, NaN, and extreme inputs", () => {
    for (const invalid of ["1.001", "1e6", "NaN", "", "100000000.01", "+1", "1,000"]) {
      expect(() => normalizeFxUsdAdjustment(invalid), invalid).toThrow(FxUsdAdjustmentOverrideError);
    }
  });
});
