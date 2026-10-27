/**
 * Phase 2 monetary USD reporting valuation.
 * Pure calculations: never create a voucher, update a balance or query live DB.
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import {
  canonicalMonetaryCurrency, monetaryFxEligibility, translateMonetaryFxBalance,
  type MonetaryFxCandidate, type MonetaryFxRate,
} from "../server/services/accounting/monetaryFxValuationCore";

const ledger = (accountType: string, code = "X", name = "Test account"): MonetaryFxCandidate => ({
  kind: "ledger", id: 10, accountType, subType: null, code, name,
});
const rateMap = (currency: string, rate: string, direction: MonetaryFxRate["direction"] = "FOREIGN_PER_USD") =>
  new Map([[currency, { currency, rate, direction, effectiveDate: "2026-10-27" }]]);
const native = (currency: string, amount: string) => new Map([[currency, new Decimal(amount)]]);

describe("monetary FX eligibility", () => {
  it("permits precisely cash/bank, customers and explicit loans", () => {
    expect(monetaryFxEligibility(ledger("Cash"))).toBe("cash_bank");
    expect(monetaryFxEligibility(ledger("bank"))).toBe("cash_bank");
    expect(monetaryFxEligibility(ledger("Loans"))).toBe("loan");
    expect(monetaryFxEligibility(ledger("Loan"))).toBe("loan");
    expect(monetaryFxEligibility({ ...ledger(""), kind: "bank" })).toBe("cash_bank");
    expect(monetaryFxEligibility({ ...ledger(""), kind: "customer" })).toBe("customer");
  });
  it("excludes supplier and unrelated liabilities, inventory, intercompany and fixed assets", () => {
    for (const type of ["Supplier", "Liability", "Current Liability", "Intercompany", "Expense", "Equity", "Fixed Asset"]) {
      expect(monetaryFxEligibility(ledger(type)), type).toBe("excluded");
    }
    expect(monetaryFxEligibility(ledger("Asset", "INVENTORY"))).toBe("excluded");
    expect(monetaryFxEligibility(ledger("Current Asset", "GOODS_IN_TRANSIT"))).toBe("excluded");
    expect(monetaryFxEligibility(ledger("Asset", "A1", "Raw Material Stock"))).toBe("excluded");
  });
  it("does not automatically value a generic Asset without a verified code", () => {
    expect(monetaryFxEligibility(ledger("Asset", "DEPOSIT_A"))).toBe("needs_review");
    expect(monetaryFxEligibility(ledger("Current Asset", "DEPOSIT_A"), {
      approvedMonetaryAssetCodes: new Set(["DEPOSIT_A"]),
    })).toBe("monetary_asset");
    expect(monetaryFxEligibility(ledger("Asset", "INVENTORY"), {
      approvedMonetaryAssetCodes: new Set(["INVENTORY"]),
    })).toBe("excluded");
  });
});

describe("read-only current USD valuation", () => {
  it("changes only USD for 61,200 CFA at rate 605 then 612", () => {
    const opening = native("CFA", "61200");
    const oldVal = translateMonetaryFxBalance(opening, new Decimal("101.157025"), rateMap("CFA", "605"));
    const nextVal = translateMonetaryFxBalance(opening, new Decimal("101.157025"), rateMap("CFA", "612"));
    expect(oldVal.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
    expect(nextVal.nativeBalancesByCurrency).toEqual({ CFA: "61200.000000" });
    expect(oldVal.currentTranslatedUsd).toBe("101.157025");
    expect(nextVal.currentTranslatedUsd).toBe("100.000000");
    expect(nextVal.translationDifferenceUsd).toBe("-1.157025");
  });
  it("preserves the sign of a loan payable or loan receivable", () => {
    expect(translateMonetaryFxBalance(native("CFA", "-61200"), new Decimal("-101.157025"), rateMap("CFA","612"))
      .currentTranslatedUsd).toBe("-100.000000");
    expect(translateMonetaryFxBalance(native("CFA", "61200"), new Decimal("101.157025"), rateMap("CFA","612"))
      .currentTranslatedUsd).toBe("100.000000");
  });
  it("does not transform native USD or add unlike currencies as local amounts", () => {
    const nativeMixed = new Map([["USD",new Decimal("10")],["ZMW",new Decimal("250")]]);
    const translated = translateMonetaryFxBalance(nativeMixed, new Decimal("20"), rateMap("ZMW","25"));
    expect(translated.nativeBalancesByCurrency).toEqual({USD:"10.000000",ZMW:"250.000000"});
    expect(translated.currentTranslatedUsd).toBe("20.000000");
    expect(translated.translationDifferenceUsd).toBe("0.000000");
  });
  it("supports an explicitly stored reverse USD-per-foreign quote", () => {
    expect(translateMonetaryFxBalance(native("EUR","10"),new Decimal("10"),rateMap("EUR","1.2","USD_PER_FOREIGN"))
      .currentTranslatedUsd).toBe("12.000000");
  });
  it("normalizes XOF into CFA and refuses missing, zero or invalid rates", () => {
    expect(canonicalMonetaryCurrency("xof")).toBe("CFA");
    expect(translateMonetaryFxBalance(native("CFA","100"),new Decimal("0"),new Map()).provisional).toBe(true);
    expect(translateMonetaryFxBalance(native("CFA","100"),new Decimal("0"),new Map()).currentTranslatedUsd).toBeNull();
    expect(translateMonetaryFxBalance(native("CFA","100"),new Decimal("0"),rateMap("CFA","0")).currentTranslatedUsd).toBeNull();
    expect(translateMonetaryFxBalance(native("CFA","100"),new Decimal("0"),rateMap("CFA","invalid")).currentTranslatedUsd).toBeNull();
    expect(translateMonetaryFxBalance(native("CFA","100"),null,rateMap("CFA","612")).currentTranslatedUsd).toBeNull();
    expect(translateMonetaryFxBalance(native("CFA","100"),new Decimal("0"),rateMap("CFA","612"),true).currentTranslatedUsd).toBeNull();
  });
  it("is deterministic and does not mutate supplied inputs when recalculated", () => {
    const source = native("CFA","61200");
    const rates = rateMap("CFA","612");
    const first = translateMonetaryFxBalance(source,new Decimal("100"),rates);
    const second = translateMonetaryFxBalance(source,new Decimal("100"),rates);
    expect(first).toEqual(second);
    expect(source.get("CFA")?.toString()).toBe("61200");
  });
});
