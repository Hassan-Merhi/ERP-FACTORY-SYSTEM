/**
 * Phase 3 manual FX correction preflight policy tests.
 * Pure logic: no database, no production mutation.
 */
import { describe, expect, it } from "vitest";
import { classifyManualFxCorrectionPreflight } from "../server/services/accounting/manualFxCorrectionPreflight";

const ready = {
  found: true,
  sourceType: "manual-journal",
  deleted: false,
  optional: false,
  reversed: false,
  reversalOfVoucherId: null,
  fxCounterType: "Indirect Expense",
  monetaryMovementCount: 2,
  otherLegacyVoucherCount: 0,
  unresolvedAccountCount: 0,
  baseCurrency: "USD",
  nonEmptyCandidates: true,
};

describe("Phase 3 manual FX correction preflight policy", () => {
  it("reports a correct, unreversed manual FX voucher as ready for accounting review, never for automatic mutation", () => {
    expect(classifyManualFxCorrectionPreflight(ready)).toEqual({
      status: "ready_for_review",
      blockers: [],
    });
  });

  it("flags the original Zambia Asset-typed FX counter for reclassification", () => {
    expect(classifyManualFxCorrectionPreflight({ ...ready, fxCounterType: "Asset" })).toEqual({
      status: "requires_review",
      blockers: ["FX_ACCOUNT_RECLASSIFICATION_REQUIRED"],
    });
  });

  it("refuses other outstanding manual FX vouchers in the same company", () => {
    expect(classifyManualFxCorrectionPreflight({ ...ready, otherLegacyVoucherCount: 2 })).toEqual({
      status: "blocked",
      blockers: ["OTHER_MANUAL_FX_VOUCHERS"],
    });
  });

  it("blocks incorrect sources, unresolved values, optional or inactive entries", () => {
    const cases = [
      { ...ready, sourceType: "pos-sale" },
      { ...ready, unresolvedAccountCount: 1 },
      { ...ready, baseCurrency: "EUR" },
      { ...ready, optional: true },
      { ...ready, deleted: true },
      { ...ready, monetaryMovementCount: 0 },
      { ...ready, nonEmptyCandidates: false },
    ];
    for (const candidate of cases) {
      expect(classifyManualFxCorrectionPreflight(candidate).status).toBe("blocked");
    }
  });

  it("identifies a prior reversal without treating it as a new journal", () => {
    expect(classifyManualFxCorrectionPreflight({ ...ready, reversed: true })).toEqual({
      status: "already_reversed",
      blockers: [],
    });
  });

  it("returns an explicit missing-voucher status", () => {
    expect(classifyManualFxCorrectionPreflight({ ...ready, found: false })).toEqual({
      status: "not_found",
      blockers: ["VOUCHER_NOT_FOUND"],
    });
  });
});
