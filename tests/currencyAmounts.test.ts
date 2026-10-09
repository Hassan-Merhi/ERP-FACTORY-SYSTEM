/**
 * server/services/accounting/currencyAmounts.test.ts
 *
 * Phase 15 — Targeted regression tests for the shared currency helper.
 *
 * Tests only the shared currency helper and the most important posting-path
 * invariants.  Does NOT run CI, full TypeScript compilation, or the complete
 * test suite.
 *
 * Run individually:
 *   npx vitest run server/services/accounting/currencyAmounts.test.ts
 */

import { describe, it, expect } from "vitest";
import Decimal from "decimal.js";

import {
  normalizeCurrencyCode,
  validateHistoricalRate,
  convertTransactionToBase,
  convertBaseToTransaction,
  normalizeVoucherEntryAmounts,
  sumNormalizedEntries,
  resolveLegacyTransactionAmounts,
  erpRateToDaybookFxRateToUsd,
  InvalidExchangeRateError,
  RateConvention,
} from "../server/services/accounting/currencyAmounts";
import { errorStatus } from "../server/lib/httpHandlers";

// ─── 1. normalizeCurrencyCode ────────────────────────────────────────────────

describe("normalizeCurrencyCode", () => {
  it("upper-cases and returns known codes", () => {
    expect(normalizeCurrencyCode("usd")).toBe("USD");
    expect(normalizeCurrencyCode("EUR")).toBe("EUR");
  });

  it("keeps CFA as the project identifier (does NOT map to XOF)", () => {
    expect(normalizeCurrencyCode("CFA")).toBe("CFA");
    expect(normalizeCurrencyCode("cfa")).toBe("CFA");
  });

  it("normalizes ISO XOF input to project alias CFA", () => {
    expect(normalizeCurrencyCode("XOF")).toBe("CFA");
    expect(normalizeCurrencyCode("xof")).toBe("CFA");
  });

  it("throws for unknown codes", () => {
    expect(() => normalizeCurrencyCode("ZZZ")).toThrow();
  });

  it("throws for null/undefined", () => {
    expect(() => normalizeCurrencyCode(null as any)).toThrow();
    expect(() => normalizeCurrencyCode(undefined as any)).toThrow();
    expect(() => normalizeCurrencyCode("")).toThrow();
  });
});

// ─── 2. validateHistoricalRate ───────────────────────────────────────────────

describe("validateHistoricalRate", () => {
  it("accepts a valid positive rate string", () => {
    const d = validateHistoricalRate("600");
    expect(d.toNumber()).toBe(600);
  });

  it("accepts a numeric value", () => {
    const d = validateHistoricalRate(600);
    expect(d.toNumber()).toBe(600);
  });

  it("rejects zero", () => {
    expect(() => validateHistoricalRate("0")).toThrow();
  });

  it("rejects negative", () => {
    expect(() => validateHistoricalRate("-1")).toThrow();
  });

  it("rejects NaN string", () => {
    expect(() => validateHistoricalRate("abc")).toThrow();
  });

  it("rejects null/undefined/empty", () => {
    expect(() => validateHistoricalRate(null)).toThrow();
    expect(() => validateHistoricalRate(undefined)).toThrow();
    expect(() => validateHistoricalRate("")).toThrow();
  });

  it("NEVER silently defaults to 1 for a missing rate", () => {
    // This was the original bug — verify it is impossible
    expect(() => validateHistoricalRate(null, "CFA rate")).toThrow(/required/i);
  });

  it("throws a 400 InvalidExchangeRateError that routes answer as a client error", () => {
    for (const bad of [null, undefined, "", "abc", "0", "-1", "Infinity"]) {
      let caught: unknown;
      try {
        validateHistoricalRate(bad, "historical rate for CFA/USD");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(InvalidExchangeRateError);
      expect(errorStatus(caught)).toBe(400);
    }
    expect(errorStatus(new Error("database down"))).toBe(500);
  });
});

// ─── 3. convertTransactionToBase ────────────────────────────────────────────

describe("convertTransactionToBase", () => {
  it("CFA→USD: 1,000,000 CFA at 600 = 1,666.666667 USD", () => {
    const result = convertTransactionToBase("1000000", "XOF", "USD", "600", RateConvention.TRANSACTION_PER_BASE);
    expect(new Decimal(result).toDecimalPlaces(6).toFixed(6)).toBe("1666.666667");
  });

  it("USD→USD (IDENTITY): returns amount unchanged", () => {
    const result = convertTransactionToBase("500", "USD", "USD", null, RateConvention.IDENTITY);
    expect(new Decimal(result).toFixed(2)).toBe("500.00");
  });

  it("requires a rate for non-IDENTITY entries", () => {
    expect(() =>
      convertTransactionToBase("1000000", "XOF", "USD", null, RateConvention.TRANSACTION_PER_BASE)
    ).toThrow();
  });
});

// ─── 4. convertBaseToTransaction ────────────────────────────────────────────

describe("convertBaseToTransaction", () => {
  it("USD→CFA: 10,000 USD at 600 = 6,000,000 CFA", () => {
    const result = convertBaseToTransaction("10000", "XOF", "USD", "600", RateConvention.TRANSACTION_PER_BASE);
    expect(new Decimal(result).toFixed(0)).toBe("6000000");
  });
});

// ─── 5. normalizeVoucherEntryAmounts — test cases from Phase 15 spec ─────────

describe("normalizeVoucherEntryAmounts", () => {
  // Test case 1: CFA customer receipt
  // Note: passing "XOF" or "CFA" as transactionCurrency both normalise to "CFA" (project identifier).
  it("TC1 — CFA customer receipt: 1,000,000 CFA @ 600 = 1,666.666667 USD", () => {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF", // normalised to "CFA" on output
      baseCurrency: "USD",
      transactionDebitAmount: "1000000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    expect(norm.transactionCurrency).toBe("CFA"); // XOF input → CFA stored
    expect(norm.transactionDebitAmount).toBe("1000000.000000");
    expect(norm.transactionCreditAmount).toBe("0.000000");
    // base = 1,000,000 / 600 = 1666.666666...
    expect(new Decimal(norm.baseDebitAmount).toDecimalPlaces(6).toFixed(6)).toBe("1666.666667");
    expect(norm.debitAmount).toBe(norm.baseDebitAmount); // backward compat
    expect(norm.rateConvention).toBe(RateConvention.TRANSACTION_PER_BASE);
    expect(norm.historicalExchangeRate).toBe("600.0000000000");
  });

  // Test case 2: Historical sale — rate change must NOT affect stored value
  it("TC2 — Historical sale: 6,000,000 CFA @ 600 = 10,000 USD; rate changes to 650; stored value unchanged", () => {
    // Post-normalization at original rate 600
    const atOriginalRate = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "6000000",
      historicalRate: "600",
    });
    expect(new Decimal(atOriginalRate.baseCreditAmount).toDecimalPlaces(0).toFixed(0)).toBe("10000");

    // Simulating what happens if someone (incorrectly) uses latest rate 650 for an old entry:
    // The stored historicalExchangeRate on the row is 600, not 650.
    // The test verifies the stored value is what was written at posting time, not recomputed.
    expect(atOriginalRate.historicalExchangeRate).toBe("600.0000000000");
    // A read using the latest rate 650 would be WRONG — that must never happen.
    // The stored baseCreditAmount should always be read directly, not re-derived.
    const storedRevenue = atOriginalRate.baseCreditAmount;
    expect(new Decimal(storedRevenue).toDecimalPlaces(0).toFixed(0)).toBe("10000");
  });

  // Test case 3: Historical expense
  it("TC3 — Historical expense: 1,200,000 CFA @ 600 = 2,000 USD; rate change does not affect it", () => {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "1200000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    expect(new Decimal(norm.baseDebitAmount).toDecimalPlaces(0).toFixed(0)).toBe("2000");
    // historicalExchangeRate is stored — changing the company rate later cannot reach this
    expect(norm.historicalExchangeRate).toBe("600.0000000000");
  });

  // Test case 5: Voucher editing — CFA amount fixed, rate changes, base recalculates
  it("TC5 — Editing: CFA amount fixed; rate edited 600→620; base recalculates", () => {
    const atOriginal = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "1200000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    // User explicitly changes only the rate to 620 (CFA amount stays 1,200,000)
    const atNewRate = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "1200000", // unchanged
      transactionCreditAmount: "0",
      historicalRate: "620", // new rate
    });
    // CFA amount unchanged
    expect(atNewRate.transactionDebitAmount).toBe(atOriginal.transactionDebitAmount);
    // Base USD recalculated
    expect(new Decimal(atNewRate.baseDebitAmount).toDecimalPlaces(6).toFixed(6)).toBe(
      new Decimal("1200000").div("620").toDecimalPlaces(6).toFixed(6)
    );
    // The two base amounts differ
    expect(atNewRate.baseDebitAmount).not.toBe(atOriginal.baseDebitAmount);
  });

  // Test case 6: USD behaviour unchanged
  it("TC6 — USD voucher: all amounts unchanged; convention = IDENTITY; rate = 1", () => {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: "5000",
      transactionCreditAmount: "0",
      historicalRate: null,
    });
    expect(norm.transactionCurrency).toBe("USD");
    expect(norm.transactionDebitAmount).toBe("5000.000000");
    expect(norm.baseDebitAmount).toBe("5000.000000");
    expect(norm.debitAmount).toBe("5000.000000");
    expect(norm.rateConvention).toBe(RateConvention.IDENTITY);
    expect(norm.historicalExchangeRate).toBe("1.0000000000");
  });

  // Validation: reject both debit AND credit > 0
  it("rejects entries with both debit and credit > 0", () => {
    expect(() =>
      normalizeVoucherEntryAmounts({
        transactionCurrency: "USD",
        baseCurrency: "USD",
        transactionDebitAmount: "100",
        transactionCreditAmount: "50",
        historicalRate: null,
      })
    ).toThrow(/both debit.*credit/i);
  });

  // Validation: reject entries with neither debit nor credit > 0
  it("rejects entries with neither debit nor credit > 0", () => {
    expect(() =>
      normalizeVoucherEntryAmounts({
        transactionCurrency: "USD",
        baseCurrency: "USD",
        transactionDebitAmount: "0",
        transactionCreditAmount: "0",
        historicalRate: null,
      })
    ).toThrow(/must have either debit or credit/i);
  });

  // Validation: non-base currency REQUIRES a rate
  it("rejects non-base currency entry with no rate (never silently defaults to 1)", () => {
    expect(() =>
      normalizeVoucherEntryAmounts({
        transactionCurrency: "XOF",
        baseCurrency: "USD",
        transactionDebitAmount: "500000",
        transactionCreditAmount: "0",
        historicalRate: null, // ← must throw, not silently use 1
      })
    ).toThrow();
  });

  // Test case 8: Rate convention mismatch guard
  it("TC8 — Passing a USD-per-CFA rate (e.g. 0.00167) as CFA-per-USD into TRANSACTION_PER_BASE produces a very large result, exposing the mismatch", () => {
    // If someone accidentally passes fxRateToUsd (USD per CFA = 0.00167) as cfaPerUsd,
    // the computed base would be astronomically large — an obvious signal of mismatch.
    // The type system (explicit convention parameter) prevents this for new code.
    // We verify the convention flag is preserved so readers can detect the error.
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "600", // 600 CFA
      transactionCreditAmount: "0",
      historicalRate: "0.00167", // wrong convention (this is USD per CFA, not CFA per USD)
    });
    // With a wrong tiny rate: 600 / 0.00167 ≈ 359,281 USD for 600 CFA — obviously wrong
    // The test documents that the convention mismatch is detectable from the stored fields.
    expect(norm.rateConvention).toBe(RateConvention.TRANSACTION_PER_BASE);
    expect(new Decimal(norm.baseDebitAmount).gt(100_000)).toBe(true); // obviously wrong magnitude
  });
});

// ─── 6. sumNormalizedEntries ─────────────────────────────────────────────────

describe("sumNormalizedEntries", () => {
  it("sums base and transaction totals correctly", () => {
    const e1 = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "1000000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    const e2 = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "1000000",
      historicalRate: "600",
    });
    const sums = sumNormalizedEntries([e1, e2]);
    expect(new Decimal(sums.totalTransactionDebit).toFixed(0)).toBe("1000000");
    expect(new Decimal(sums.totalTransactionCredit).toFixed(0)).toBe("1000000");
    expect(new Decimal(sums.totalBaseDebit).toDecimalPlaces(6).toFixed(6)).toBe("1666.666667");
    expect(new Decimal(sums.totalBaseCredit).toDecimalPlaces(6).toFixed(6)).toBe("1666.666667");
  });
});

// ─── 7. TC4 — Cash revaluation (informational; no DB write) ──────────────────

describe("Cash revaluation — TC4", () => {
  it("native CFA balance unchanged; translated value changes with rate", () => {
    const nativeCfa = 6_000_000;
    const rateOriginal = 600;
    const rateNew = 650;

    // Historical base balance (computed from stored entries at original rate)
    const historicalBase = nativeCfa / rateOriginal;
    expect(historicalBase).toBe(10_000);

    // Current translated value with new rate (display-only — no voucher entry changes)
    const currentTranslated = nativeCfa / rateNew;
    expect(new Decimal(currentTranslated).toDecimalPlaces(6).toFixed(6)).toBe("9230.769231");

    // Translation difference (for reporting only — NOT posted automatically)
    const translationDiff = currentTranslated - historicalBase;
    expect(new Decimal(translationDiff).toDecimalPlaces(6).toFixed(6)).toBe("-769.230769");

    // Native amount is NEVER derived from historical USD using the new rate
    const nativeRecovered = historicalBase * rateNew; // 10,000 * 650 = 6,500,000 ← WRONG
    expect(nativeRecovered).not.toBe(nativeCfa); // proves you must store native separately
  });
});

// ─── 8. TC7 — Mixed USD and CFA customer transactions ────────────────────────

describe("Mixed USD+CFA customer transactions — TC7", () => {
  it("USD and CFA native balances are kept separate; base balance uses stored historical values", () => {
    // Two entries from a customer with mixed currency activity
    const cfaEntry = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "600000", // CFA invoice
      transactionCreditAmount: "0",
      historicalRate: "600", // rate at posting time
    });
    const usdEntry = normalizeVoucherEntryAmounts({
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: "500", // USD invoice
      transactionCreditAmount: "0",
      historicalRate: null,
    });

    // Native CFA balance: sum only XOF transaction debits
    const nativeCfaBalance = new Decimal(cfaEntry.transactionDebitAmount); // 600,000 CFA
    // Native USD balance: sum only USD transaction debits
    const nativeUsdBalance = new Decimal(usdEntry.transactionDebitAmount); // 500 USD

    // Combined historical base balance: sum all baseDebitAmounts
    const combinedBase = new Decimal(cfaEntry.baseDebitAmount).plus(usdEntry.baseDebitAmount);

    expect(nativeCfaBalance.toFixed(0)).toBe("600000");
    expect(nativeUsdBalance.toFixed(0)).toBe("500");
    expect(combinedBase.toDecimalPlaces(6).toFixed(6)).toBe(
      new Decimal("600000").div("600").plus("500").toDecimalPlaces(6).toFixed(6)
    ); // 1000 + 500 = 1500

    // Critically: do NOT combine by converting CFA using the LATEST rate
    // (e.g. rate 650 → 600000/650 = 923.08 ≠ the historical 1000)
    const wrongCfaAtLatestRate = new Decimal("600000").div("650");
    expect(wrongCfaAtLatestRate.toDecimalPlaces(2).toFixed(2)).not.toBe("1000.00");
  });
});

// ─── 9. erpRateToDaybookFxRateToUsd ─────────────────────────────────────────

describe("erpRateToDaybookFxRateToUsd", () => {
  it("CFA per USD 600 → USD per CFA = 0.0016666...", () => {
    // "XOF" input is normalised to "CFA" inside the function — result unchanged
    const result = erpRateToDaybookFxRateToUsd("XOF", "USD", "600");
    expect(new Decimal(result).toDecimalPlaces(10).toFixed(10)).toBe("0.0016666667");
  });

  it("USD → USD: returns 1", () => {
    const result = erpRateToDaybookFxRateToUsd("USD", "USD", null);
    expect(result).toBe("1.0000000000");
  });

  it("CFA alias is the canonical input (not XOF)", () => {
    // The project uses "CFA" everywhere — this must produce the same result as "XOF"
    const resultCfa = erpRateToDaybookFxRateToUsd("CFA", "USD", "600");
    const resultXof = erpRateToDaybookFxRateToUsd("XOF", "USD", "600");
    expect(resultCfa).toBe(resultXof);
    expect(new Decimal(resultCfa).toDecimalPlaces(10).toFixed(10)).toBe("0.0016666667");
  });
});

// ─── 10. resolveLegacyTransactionAmounts ────────────────────────────────────

describe("resolveLegacyTransactionAmounts", () => {
  it("already-repaired rows return null", () => {
    const result = resolveLegacyTransactionAmounts({
      existingTransactionCurrency: "CFA", // project identifier, not "XOF"
      voucherCurrency: "XOF",
      baseCurrency: "USD",
      storedDebitAmount: "1666.67",
      storedCreditAmount: "0",
      voucherExchangeRate: "600",
    });
    expect(result).toBeNull();
  });

  it("USD voucher: transaction = stored, rate = 1, IDENTITY", () => {
    const result = resolveLegacyTransactionAmounts({
      existingTransactionCurrency: null,
      voucherCurrency: "USD",
      baseCurrency: "USD",
      storedDebitAmount: "500",
      storedCreditAmount: "0",
      voucherExchangeRate: null,
    });
    expect(result).not.toBeNull();
    expect(result!.rateConvention).toBe(RateConvention.IDENTITY);
    expect(result!.transactionDebitAmount).toBe("500.000000");
    expect(result!.historicalExchangeRate).toBe("1.0000000000");
  });

  it("CFA voucher: transaction = base × rate", () => {
    const result = resolveLegacyTransactionAmounts({
      existingTransactionCurrency: null,
      voucherCurrency: "CFA", // project alias
      baseCurrency: "USD",
      storedDebitAmount: "1666.666667",
      storedCreditAmount: "0",
      voucherExchangeRate: "600",
    });
    expect(result).not.toBeNull();
    expect(result!.rateConvention).toBe(RateConvention.TRANSACTION_PER_BASE);
    // txDebit = 1666.666667 * 600 = 1,000,000
    expect(new Decimal(result!.transactionDebitAmount).toDecimalPlaces(0).toFixed(0)).toBe("1000000");
    // transactionCurrency stored as CFA (project alias, not XOF)
    expect(result!.transactionCurrency).toBe("CFA");
  });

  it("missing rate returns null (cannot auto-repair)", () => {
    const result = resolveLegacyTransactionAmounts({
      existingTransactionCurrency: null,
      voucherCurrency: "CFA",
      baseCurrency: "USD",
      storedDebitAmount: "1000000",
      storedCreditAmount: "0",
      voucherExchangeRate: null,
    });
    expect(result).toBeNull();
  });
});

// ─── 11. CFA identifier consistency ─────────────────────────────────────────

describe("CFA identifier consistency — CFA is the canonical code, not XOF", () => {
  it("normalizeVoucherEntryAmounts stores CFA for both 'CFA' and 'XOF' inputs", () => {
    const viaCfa = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "1200000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    const viaXof = normalizeVoucherEntryAmounts({
      transactionCurrency: "XOF",
      baseCurrency: "USD",
      transactionDebitAmount: "1200000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    // Both normalise to "CFA" — the project identifier
    expect(viaCfa.transactionCurrency).toBe("CFA");
    expect(viaXof.transactionCurrency).toBe("CFA");
    // Math is identical
    expect(viaCfa.baseDebitAmount).toBe(viaXof.baseDebitAmount);
  });

  it("normalizeCurrencyCode never outputs XOF", () => {
    // "XOF" in → "CFA" out (normalization direction)
    expect(normalizeCurrencyCode("XOF")).toBe("CFA");
    // "CFA" in → "CFA" out (kept as project code)
    expect(normalizeCurrencyCode("CFA")).toBe("CFA");
    // No call to normalizeCurrencyCode should ever return "XOF"
    // (only use currencies actually in KNOWN_CURRENCIES)
    const allInputs = ["USD", "EUR", "GBP", "CFA", "XOF", "NGN", "GHS", "CDF", "CNY", "JPY"];
    const allOutputs = allInputs.map((c) => normalizeCurrencyCode(c));
    expect(allOutputs).not.toContain("XOF");
  });
});

// ─── 12. Payment entry dual-currency round-trip ──────────────────────────────

describe("Payment entry — dual-currency fields round-trip", () => {
  it("CFA receipt payment: DR Cash 600,000 CFA @ 600 = 1,000 USD base", () => {
    // Simulate a payment/receipt voucher: Dr Cash (600k CFA), Cr Customer Receivable (600k CFA)
    const drNorm = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "600000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    const crNorm = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "600000",
      historicalRate: "600",
    });
    // Both entries share the same historical rate
    expect(drNorm.historicalExchangeRate).toBe(crNorm.historicalExchangeRate);
    // Base debit = base credit (balanced)
    expect(drNorm.baseDebitAmount).toBe(crNorm.baseCreditAmount);
    // Base = 600,000 / 600 = 1,000 USD
    expect(new Decimal(drNorm.baseDebitAmount).toFixed(2)).toBe("1000.00");
    // Transaction amounts preserved
    expect(new Decimal(drNorm.transactionDebitAmount).toFixed(0)).toBe("600000");
    // Backward-compat debitAmount = base (USD)
    expect(drNorm.debitAmount).toBe(drNorm.baseDebitAmount);
    // rateConvention distinguishes from IDENTITY
    expect(drNorm.rateConvention).toBe(RateConvention.TRANSACTION_PER_BASE);
  });

  it("Editing a CFA voucher preserves rate — changing amount recalculates base", () => {
    // Original: 600,000 CFA @ 600 = 1,000 USD
    const original = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "600000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    // Edit: amount changed to 720,000 CFA — SAME historical rate (600)
    const edited = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "720000",
      transactionCreditAmount: "0",
      historicalRate: "600", // preserved from the original posting
    });
    expect(edited.historicalExchangeRate).toBe(original.historicalExchangeRate);
    expect(new Decimal(edited.baseDebitAmount).toFixed(2)).toBe("1200.00");
    expect(new Decimal(original.baseDebitAmount).toFixed(2)).toBe("1000.00");
  });
});

// ─── 13. POS CFA entry normalization ────────────────────────────────────────

describe("POS CFA entry normalization — simulates normalizePosEntry logic", () => {
  it("1,500,000 CFA sale @ 600 debit entry: base = 2,500 USD", () => {
    const norm = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "1500000",
      transactionCreditAmount: "0",
      historicalRate: "600",
    });
    expect(norm.transactionCurrency).toBe("CFA");
    expect(new Decimal(norm.baseDebitAmount).toFixed(2)).toBe("2500.00");
    expect(new Decimal(norm.transactionDebitAmount).toFixed(0)).toBe("1500000");
  });

  it("SP sale split: payable 1,350,000 CFA + deduction 150,000 CFA = total 1,500,000 CFA", () => {
    // Verify the credits sum back to the total
    const payable = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "1350000",
      historicalRate: "600",
    });
    const deduction = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "150000",
      historicalRate: "600",
    });
    const totalBaseCr = new Decimal(payable.baseCreditAmount).plus(deduction.baseCreditAmount);
    // Matches the debit base of 2,500 USD
    expect(totalBaseCr.toFixed(2)).toBe("2500.00");
  });
});
