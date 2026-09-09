import { describe, expect, it } from "vitest";
import {
  normalizeLoadingArticleCode,
  shouldEnforceProformaOverload,
  shouldRequireProformaMembership,
  sumProformaQuantityLimit,
} from "../server/routes/factory/customer-orders/bale-scanning/proformaScanPolicy";

describe("factory loading proforma scan policy", () => {
  it("normalizes proforma article codes across whitespace and case", () => {
    expect(normalizeLoadingArticleCode("  AbC-123  ")).toBe("abc-123");
    expect(normalizeLoadingArticleCode(null)).toBe("");
  });

  it("Ignore Proforma bypasses the overload confirmation on the first scan", () => {
    expect(
      shouldEnforceProformaOverload({
        ignoreProforma: true,
        allowBypassOverload: false,
      })
    ).toBe(false);
  });

  it("keeps the normal double-scan overload confirmation when Ignore Proforma is off", () => {
    expect(
      shouldEnforceProformaOverload({
        ignoreProforma: false,
        allowBypassOverload: false,
      })
    ).toBe(true);
    expect(
      shouldEnforceProformaOverload({
        ignoreProforma: false,
        allowBypassOverload: true,
      })
    ).toBe(false);
  });

  it("allows a bale removed from the same loading order to be reinstated without an overload prompt", () => {
    expect(
      shouldEnforceProformaOverload({
        ignoreProforma: false,
        allowBypassOverload: false,
        isReinstatingRemovedBale: true,
      })
    ).toBe(false);
  });

  it("sums equivalent proforma rows into one quantity limit", () => {
    expect(sumProformaQuantityLimit([{ quantity: 8 }, { quantity: 12 }, { quantity: "5" }])).toBe(25);
  });

  it("Ignore Proforma bypasses not-in-proforma confirmation but normal mode still requires it", () => {
    expect(shouldRequireProformaMembership({ ignoreProforma: true, hasProformaLine: false })).toBe(false);
    expect(shouldRequireProformaMembership({ ignoreProforma: false, hasProformaLine: false })).toBe(true);
    expect(shouldRequireProformaMembership({ ignoreProforma: false, hasProformaLine: true })).toBe(false);
  });
});
