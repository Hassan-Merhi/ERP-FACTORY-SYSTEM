/**
 * Phase 6: deterministic, DB-free monetary reconciliation scenarios.
 * Execute with Vitest before merging or deploying.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  applyVerifiedMonetaryFxOverlay, applyCurrentAccountsFxOverlay,
  applyCurrentCustomerFxOverlay, monetaryReportRowKey,
  type MonetaryNetPositionPayload,
} from "../server/services/accounting/monetaryFxReportOverlay";
import {
  translateMonetaryFxBalance, monetaryFxEligibility,
} from "../server/services/accounting/monetaryFxValuationCore";
import type {
  MonetaryFxValuationResult, MonetaryFxValuationRow,
} from "../server/services/accounting/monetaryFxValuationService";

function account(
  accountKey: string,
  historicalBaseUsd: string,
  currentTranslatedUsd: string | null,
  category: "cash_bank" | "customer" | "loan" | "monetary_asset" = "cash_bank",
  provisional = false
): MonetaryFxValuationRow {
  const [kind, rawId] = accountKey.split(":");
  const id = Number(rawId);
  return {
    accountKey,
    accountKind: kind as MonetaryFxValuationRow["accountKind"],
    id,
    linkedLedgerId: kind === "customer" ? 33 : null,
    code: "TEST",
    name: accountKey,
    category,
    eligibility: category,
    deleted: false,
    nativeBalancesByCurrency: { CFA: "61200.000000" },
    historicalBaseUsd,
    bookClosingUsd: new Decimal(historicalBaseUsd).toDecimalPlaces(2).toFixed(6),
    currentTranslatedUsd,
    translationDifferenceUsd: currentTranslatedUsd === null ? null
      : new Decimal(currentTranslatedUsd).minus(historicalBaseUsd).toFixed(6),
    unresolvedCurrencies: provisional ? ["CFA"] : [],
    unresolvedEntryCount: provisional ? 1 : 0,
    unresolvedOpening: false,
    openingBookMismatch: false,
    provisional,
  };
}

function valuation(accounts: MonetaryFxValuationRow[], companyId = 101): MonetaryFxValuationResult {
  return {
    companyId,
    businessDate: "2026-10-27",
    valuationMode: "CURRENT",
    baseCurrency: "USD",
    bookBalancesModified: false,
    fxVouchersPosted: false,
    accounts,
    rates: [{ currency: "CFA", rate: "612", direction: "FOREIGN_PER_USD", effectiveDate: "2026-10-27" }],
    rateErrorsByCurrency: {},
    eligibleAccountCount: accounts.length,
    unresolvedAccountCount: accounts.filter((a) => a.provisional).length,
    needsReviewCount: 0,
    excludedLedgerAndPartyCounts: { excludedMasters: 0, customerLinkedLedgerMasters: 1 },
  };
}

describe("Phase 6 signed net-position reconciliation", () => {
  it("replaces cash, customer and loan by owner ID exactly once; stock and suppliers remain unchanged", () => {
    const payload: MonetaryNetPositionPayload = {
      forUs: {
        total: 1151.16,
        accounts: [
          { id: 10, name: "CFA Cash", category: "Cash", value: 101.16 },
          { id: 33, partyKind: "customer", partyId: 3, name: "Client", category: "Customer", value: 50 },
          { code: "INVENTORY", name: "Stock", category: "Inventory", value: 1000 },
        ],
      },
      onUs: {
        total: 320,
        accounts: [
          { id: 20, name: "Loan", category: "Loans", value: 20 },
          { partyKind: "supplier", partyId: 6, name: "Supplier", category: "Supplier", value: 300 },
        ],
      },
      netPosition: 831.16,
      equity: { total: 0, includedInNetPosition: false },
    };
    const sourceBefore = JSON.parse(JSON.stringify(payload));
    const projected = applyVerifiedMonetaryFxOverlay(payload, valuation([
      account("ledger:10", "101.16", "100"),
      account("customer:3", "50", "40", "customer"),
      account("ledger:20", "-20", "-25", "loan"),
    ]));
    expect(projected.appliedKeys).toEqual(["ledger:10", "customer:3", "ledger:20"]);
    expect(projected.payload.forUsTotal).toBe(1140);
    expect(projected.payload.onUsTotal).toBe(325);
    expect(projected.payload.netPosition).toBe(815);
    expect(projected.payload.forUs?.accounts.find((r) => r.code === "INVENTORY")?.value).toBe(1000);
    expect(projected.payload.onUs?.accounts.find((r) => r.partyKind === "supplier")?.value).toBe(300);
    expect(projected.payload.forUs?.accounts.filter((r) => monetaryReportRowKey(r) === "customer:3")).toHaveLength(1);
    expect(projected.currentMonetaryTranslationDifferenceUsd).toBe("-16.160000");
    expect(sourceBefore.netPosition).toBe(831.16);
    // A second projection on an already-translated report must not count it twice.
    const twice = applyVerifiedMonetaryFxOverlay(projected.payload, valuation([
      account("ledger:10", "101.16", "100"),
      account("customer:3", "50", "40", "customer"),
      account("ledger:20", "-20", "-25", "loan"),
    ]));
    expect(twice.appliedKeys).toEqual([]);
    expect(twice.payload.netPosition).toBe(815);
  });

  it("moves a signed loan receivable to the payable side without duplicating it", () => {
    const p: MonetaryNetPositionPayload = {
      forUs: { total: 100, accounts: [{ id: 8, name: "Loan", category: "Loan Deposits", value: 100 }] },
      onUs: { total: 10, accounts: [{ name: "Other liability", value: 10 }] },
      netPosition: 90,
    };
    const outcome = applyVerifiedMonetaryFxOverlay(p, valuation([account("ledger:8", "100", "-50", "loan")]));
    expect(outcome.appliedKeys).toEqual(["ledger:8"]);
    expect(outcome.payload.forUsTotal).toBe(0);
    expect(outcome.payload.onUsTotal).toBe(60);
    expect(outcome.payload.netPosition).toBe(-60);
    expect(outcome.payload.onUs?.accounts.find((r) => r.id === 8)?.value).toBe(50);
  });

  it("refuses mismatched history, unknown customer ownership and duplicate rows", () => {
    const p: MonetaryNetPositionPayload = {
      forUs: {
        total: 70,
        accounts: [
          { id: 10, name: "Cash", value: 25 },
          { id: 33, partyKind: "customer", partyId: 3, name: "Customer", value: 20 },
          { id: 11, name: "Other cash", value: 25 },
        ],
      },
      onUs: { total: 0, accounts: [] },
    };
    const result = applyVerifiedMonetaryFxOverlay(p, valuation([
      account("ledger:10", "100", "200"),
      account("ledger:33", "20", "300"),
      account("ledger:11", "25", null, "cash_bank", true),
    ]));
    expect(result.appliedKeys).toEqual([]);
    expect(result.skipped).toEqual([
      { key: "ledger:10", reason: "historical_usd_mismatch" },
      { key: "ledger:33", reason: "missing_in_report" },
      { key: "ledger:11", reason: "unresolved" },
    ]);
    // Nothing applied: the source report is returned untouched (no totals rewritten).
    expect(result.payload.forUsTotal).toBeUndefined();
    expect(result.payload.forUs?.total).toBe(70);
  });

  it("uses only configured monetary account types, with no supplier or inventory translation", () => {
    for (const type of ["Supplier", "Inventory", "Expense", "Liability", "Intercompany", "Fixed Asset"]) {
      expect(monetaryFxEligibility({
        kind: "ledger", id: 20, name: type, code: type, accountType: type, subType: null,
      })).toBe("excluded");
    }
    expect(monetaryFxEligibility({
      kind: "ledger", id: 21, name: "Security Deposit", code: "DEPOSIT_CFA", accountType: "Asset", subType: null,
    })).toBe("needs_review");
  });

  it("keeps native CFA and USD separate, and revalues only the current USD equivalent", () => {
    const native = new Map([["CFA", new Decimal("61200")], ["USD", new Decimal("10")]]);
    const oldRate = new Map([["CFA", { currency: "CFA", rate: "605", direction: "FOREIGN_PER_USD" as const, effectiveDate: "2026-10-20" }]]);
    const newRate = new Map([["CFA", { currency: "CFA", rate: "612", direction: "FOREIGN_PER_USD" as const, effectiveDate: "2026-10-27" }]]);
    const oldValue = translateMonetaryFxBalance(native, new Decimal("111.157025"), oldRate);
    const newValue = translateMonetaryFxBalance(native, new Decimal("111.157025"), newRate);
    expect(oldValue.currentTranslatedUsd).toBe("111.157025");
    expect(newValue.currentTranslatedUsd).toBe("110.000000");
    expect(newValue.translationDifferenceUsd).toBe("-1.157025");
    expect(newValue.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000", USD: "10.000000" });
    expect(native.get("CFA")?.eq("61200")).toBe(true);
  });

  it("preserves a Factory customer's memo and refuses to translate a mismatched combined balance", () => {
    const rows = [{ id: 3, balance: 105, balanceSide: "Dr", ledgerBalance: 100,
      ledgerBalanceSide: "Dr", notInLedgerTotal: 5, heldUnfinalizedCharges: 0 }];
    const result = applyCurrentCustomerFxOverlay(rows, valuation([account("customer:3", "100", "95", "customer")]));
    expect(result[0].balance).toBe(105);
    expect(result[0].monetaryFxProvisional).toBe(true);
    expect(result[0].currencyRevalued).toBeUndefined();
  });

  it("uses a customer-linked ledger's customer ID on the Accounts list", () => {
    const rows = [
      { type: "ledger", accountId: 33, customerId: 3, balance: "100.00", balanceSide: "Dr" },
      { type: "fixedAsset", accountId: 12, balance: "300.00", balanceSide: "Dr" },
    ];
    const result = applyCurrentAccountsFxOverlay(rows, valuation([account("customer:3", "100", "95", "customer")]));
    expect(result[0].balance).toBe("95.00");
    expect(result[0].currencyRevalued).toBe(true);
    expect(result[1].balance).toBe("300.00");
  });
});
