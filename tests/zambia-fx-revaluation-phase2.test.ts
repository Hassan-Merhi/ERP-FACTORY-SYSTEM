/**
 * Phase 2 — Zambia 20.8 -> 20.9 FX regression.
 * DB-free; the original production monetary evidence is encoded as a fixture.
 * The live accounting data is never accessed or changed by these tests.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { postedFxRevaluationAdjustmentUsd } from "../server/services/accounting/fxRevaluationAmount";
import { legacyManualFxConflictReason } from "../server/services/accounting/legacyManualFxGuard";
import { statusForSameNamedSystemAccount } from "../server/services/accounting/systemAccountNameStatus";
import { applyVerifiedMonetaryFxOverlay } from "../server/services/accounting/monetaryFxReportOverlay";
import type {
  MonetaryFxValuationResult,
  MonetaryFxValuationRow,
} from "../server/services/accounting/monetaryFxValuationService";

const RATE = new Decimal("20.9");
const KITWE = { id: 4334, native: "68530", priorUsdPosted: "3290.55", correctedUsdPosted: "3278.95" };
const LUSAKA = { id: 4335, native: "161050", priorUsdPosted: "7739.77", correctedUsdPosted: "7705.74" };

function currentValue(native: string): string {
  return new Decimal(native).div(RATE).toDecimalPlaces(6).toFixed(6);
}
function fxRow(row: typeof KITWE): MonetaryFxValuationRow {
  const translated = currentValue(row.native);
  return {
    accountKey: `ledger:${row.id}`,
    accountKind: "ledger",
    id: row.id,
    linkedLedgerId: null,
    code: row.id === 4334 ? "KITCAS" : "LUSCAS",
    name: row.id === 4334 ? "KITWE CASH" : "LUSAKA CASH",
    category: "cash_bank",
    eligibility: "cash_bank",
    deleted: false,
    nativeBalancesByCurrency: { ZMW: `${row.native}.000000` },
    historicalBaseUsd: row.correctedUsdPosted,
    bookClosingUsd: row.correctedUsdPosted,
    currentTranslatedUsd: translated,
    translationDifferenceUsd: new Decimal(translated).minus(row.correctedUsdPosted).toFixed(6),
    unresolvedCurrencies: [],
    unresolvedEntryCount: 0,
    unresolvedOpening: false,
    openingBookMismatch: false,
    provisional: false,
  };
}
function valuation(): MonetaryFxValuationResult {
  return {
    companyId: 19,
    businessDate: "2026-11-20",
    valuationMode: "CURRENT",
    baseCurrency: "USD",
    bookBalancesModified: false,
    fxVouchersPosted: false,
    accounts: [fxRow(KITWE), fxRow(LUSAKA)],
    rates: [{ currency: "ZMW", rate: "20.9", direction: "FOREIGN_PER_USD", effectiveDate: "2026-11-19" }],
    rateErrorsByCurrency: {},
    eligibleAccountCount: 2,
    unresolvedAccountCount: 0,
    needsReviewCount: 0,
    excludedLedgerAndPartyCounts: { excludedMasters: 0, customerLinkedLedgerMasters: 0 },
  };
}

describe("Zambia manual FX Phase 2 accounting correction contract", () => {
  it("refuses the wrong-type legacy FX asset while preserving the original account", () => {
    const candidate = { id: 4404, code: "FXREVGAI", account_type: "Asset" };
    const expected = {
      code: "FX-REVALUATION",
      name: "FX Revaluation Gain/Loss",
      accountType: "Indirect Expense",
      required: false,
      purpose: "exchange differences",
    };
    expect(statusForSameNamedSystemAccount(expected, candidate)).toEqual({
      code: "FX-REVALUATION",
      state: "type_differs",
      accountId: 4404,
      expectedType: "Indirect Expense",
      actualType: "Asset",
    });
    expect(statusForSameNamedSystemAccount(expected, { ...candidate, account_type: "Indirect Expense" })).toEqual({
      code: "FX-REVALUATION",
      state: "reused_by_name",
      accountId: 4404,
      actualCode: "FXREVGAI",
    });
  });

  it("uses POSTED cents, not six-decimal historical base, to split the $45.63 rate loss", () => {
    const kitwe = postedFxRevaluationAdjustmentUsd(currentValue(KITWE.native), KITWE.priorUsdPosted);
    const lusaka = postedFxRevaluationAdjustmentUsd(currentValue(LUSAKA.native), LUSAKA.priorUsdPosted);
    expect(kitwe).toBe("-11.60");
    expect(lusaka).toBe("-34.03");
    expect(new Decimal(kitwe).plus(lusaka).toFixed(2)).toBe("-45.63");
  });

  it("a second revaluation at 20.9 is a no-op after an approved base-only correction", () => {
    expect(postedFxRevaluationAdjustmentUsd(currentValue(KITWE.native), KITWE.correctedUsdPosted)).toBe("0.00");
    expect(postedFxRevaluationAdjustmentUsd(currentValue(LUSAKA.native), LUSAKA.correctedUsdPosted)).toBe("0.00");
  });

  it("does not re-add a virtual FX liability after the corrected journal is recognized", () => {
    const payload = {
      forUs: {
        total: 10984.69,
        accounts: [
          { id: KITWE.id, name: "KITWE CASH", code: "KITCAS", category: "Cash", value: 3278.95 },
          { id: LUSAKA.id, name: "LUSAKA CASH", code: "LUSCAS", category: "Cash", value: 7705.74 },
        ],
      },
      onUs: { total: 0, accounts: [] },
      netPosition: 10984.69,
    };
    const calculated = applyVerifiedMonetaryFxOverlay(payload, valuation(), { showFxAsRows: true });
    expect(calculated.appliedKeys).toEqual(["ledger:4334", "ledger:4335"]);
    expect(calculated.payload.netPosition).toBe(10984.69);
    expect(calculated.payload.onUs?.accounts.some((row) => row.code === "FX_UNREALIZED_LOSS")).toBe(false);
    expect(calculated.payload.forUs?.accounts.some((row) => row.code === "FX_UNREALIZED_GAIN")).toBe(false);
    const twice = applyVerifiedMonetaryFxOverlay(calculated.payload, valuation(), { showFxAsRows: true });
    expect(twice.appliedKeys).toEqual([]);
    expect(twice.payload.netPosition).toBe(10984.69);
  });

  it("rejects misleadingly silent revaluation on legacy native-USD vouchers", () => {
    const reason = legacyManualFxConflictReason([{ voucherId: 18113, voucherNumber: "JV-19-2026-000001" }]);
    expect(reason).toContain("JV-19-2026-000001");
    expect(reason).toContain("BASE_ONLY_REVALUATION");
    expect(reason).toContain("No new journal was created");
  });

  it("keeps conversion stable if the rate is saved repeatedly or a loss is reversed", () => {
    const original = postedFxRevaluationAdjustmentUsd(currentValue(KITWE.native), KITWE.priorUsdPosted);
    const posted = new Decimal(KITWE.priorUsdPosted).plus(original).toFixed(2);
    expect(posted).toBe(KITWE.correctedUsdPosted);
    expect(postedFxRevaluationAdjustmentUsd(currentValue(KITWE.native), posted)).toBe("0.00");
    const reversed = new Decimal(posted).minus(original).toFixed(2);
    expect(reversed).toBe(KITWE.priorUsdPosted);
    expect(postedFxRevaluationAdjustmentUsd(currentValue(KITWE.native), reversed)).toBe(original);
  });
});
