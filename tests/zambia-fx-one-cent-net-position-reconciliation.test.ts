import { describe, expect, it } from "vitest";
import { applyVerifiedMonetaryFxOverlay, type MonetaryNetPositionPayload } from "../server/services/accounting/monetaryFxReportOverlay";
import type { MonetaryFxValuationResult, MonetaryFxValuationRow } from "../server/services/accounting/monetaryFxValuationService";

function cash(id: number, historical: string, posted: string, translated: string): MonetaryFxValuationRow {
  return {
    accountKey: `ledger:${id}`, accountKind: "ledger", id,
    linkedLedgerId: null, code: `CASH-${id}`, name: `Cash ${id}`,
    category: "cash_bank", eligibility: "cash_bank", deleted: false,
    nativeBalancesByCurrency: id === 4335 ? { ZMW: "161050.000000" } : { ZMW: "68530.000000" },
    historicalBaseUsd: historical, bookClosingUsd: posted, currentTranslatedUsd: translated,
    translationDifferenceUsd: (Number(translated) - Number(historical)).toFixed(6),
    unresolvedCurrencies: [], unresolvedEntryCount: 0, unresolvedOpening: false,
    openingBookMismatch: false, provisional: false,
  };
}
function valuation(rows: MonetaryFxValuationRow[]): MonetaryFxValuationResult {
  return {
    companyId: 19, businessDate: "2026-11-20", valuationMode: "CURRENT",
    baseCurrency: "USD", bookBalancesModified: false, fxVouchersPosted: false,
    accounts: rows, rates: [{ currency: "ZMW", rate: "20.9", direction: "FOREIGN_PER_USD", effectiveDate: "2026-11-19" }],
    rateErrorsByCurrency: {}, eligibleAccountCount: rows.length, unresolvedAccountCount: 0,
    needsReviewCount: 0, excludedLedgerAndPartyCounts: { excludedMasters: 0, customerLinkedLedgerMasters: 0 },
  };
}
function cashReport(): MonetaryNetPositionPayload {
  return {
    forUs: {
      total: 181001.28, accounts: [
        { id: 4334, name: "KITWE CASH", category: "Cash", value: 3278.95 },
        { id: 4335, name: "LUSAKA CASH", category: "Cash", value: 7705.73 },
        { code: "INVENTORY", name: "Inventory", category: "Inventory", value: 170016.60 },
      ],
      breakdown: [{ name: "Cash", value: 10984.68 }, { name: "Inventory", value: 170016.60 }],
    },
    onUs: { total: 177540.38, accounts: [{ code: "LIABILITIES", name: "Liabilities", value: 177540.38 }] },
    netPosition: 3460.90,
  };
}

describe("Zambia posted FX revaluation 1-cent report reconciliation", () => {
  it("returns the cent to LUSAKA cash rather than showing fictitious unrealized FX", () => {
    // Production evidence after voucher 18134 was correctly repaired:
    // the six-decimal base row rounds to 7705.73, posted book to 7705.74,
    // 161050 ZMW / 20.9 translates to 7705.741627.
    const result = applyVerifiedMonetaryFxOverlay(cashReport(), valuation([
      cash(4334, "3278.952539", "3278.950000", "3278.947368"),
      cash(4335, "7705.733526", "7705.740000", "7705.741627"),
    ]), { showFxAsRows: true });
    expect(result.payload.forUs?.accounts.find((r) => r.id === 4335)?.value).toBe(7705.74);
    expect(result.payload.forUs?.accounts.find((r) => r.code === "FX_UNREALIZED_GAIN")).toBeUndefined();
    expect(result.payload.onUs?.accounts.find((r) => r.code === "FX_UNREALIZED_LOSS")).toBeUndefined();
    expect(result.payload.forUsTotal).toBe(181001.29);
    expect(result.payload.netPosition).toBe(3460.91);
    expect(result.payload.forUs?.breakdown?.find((r) => r.name === "Cash")?.value).toBe(10984.69);
  });

  it("preserves a real current-rate FX gain whenever posted cash cents differ", () => {
    const report: MonetaryNetPositionPayload = {
      forUs: { total: 100, accounts: [{ id: 90, name: "Foreign Cash", category: "Cash", value: 100 }] },
      onUs: { total: 0, accounts: [] }, netPosition: 100,
    };
    const out = applyVerifiedMonetaryFxOverlay(report, valuation([
      cash(90, "100.000000", "100.000000", "101.000000"),
    ]), { showFxAsRows: true });
    expect(out.payload.forUs?.accounts.find((r) => r.id === 90)?.value).toBe(100);
    expect(out.payload.forUs?.accounts.find((r) => r.code === "FX_UNREALIZED_GAIN")?.value).toBe(1);
    expect(out.payload.netPosition).toBe(101);
  });

  it("does not change a posted amount unless the rounded current translation equals the posted book", () => {
    const report: MonetaryNetPositionPayload = {
      forUs: { total: 7705.73, accounts: [{ id: 4335, name: "LUSAKA CASH", category: "Cash", value: 7705.73 }] },
      onUs: { total: 0, accounts: [] },
    };
    const out = applyVerifiedMonetaryFxOverlay(report, valuation([
      cash(4335, "7705.733526", "7705.740000", "7705.761627"),
    ]), { showFxAsRows: true });
    expect(out.payload.forUs?.accounts.find((r) => r.id === 4335)?.value).toBe(7705.73);
    expect(out.payload.forUs?.accounts.find((r) => r.code === "FX_UNREALIZED_GAIN")?.value).toBe(0.03);
  });
});
