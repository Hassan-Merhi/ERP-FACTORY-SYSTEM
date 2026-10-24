import { describe, expect, it } from "vitest";

import {
  RateConvention,
  classifyVoucherEntryFallback,
  convertBaseToTransaction,
  convertTransactionToBase,
  erpRateToDaybookFxRateToUsd,
  normalizeCurrencyCode,
  normalizeVoucherEntryAmounts,
  resolveLegacyTransactionAmounts,
  sumNormalizedEntries,
  validateHistoricalRate,
} from "../server/services/accounting/currencyAmounts";

describe("currency amount domain behavior", () => {
  it("normalizes supported currency codes and rejects invalid codes", () => {
    expect(normalizeCurrencyCode(" usd ")).toBe("USD");
    expect(normalizeCurrencyCode("xof")).toBe("CFA");
    expect(normalizeCurrencyCode("cfa")).toBe("CFA");
    expect(() => normalizeCurrencyCode(" ")).toThrow("Unsupported currency code");
    expect(() => normalizeCurrencyCode("BTC")).toThrow("Unsupported currency code");
  });

  it("validates positive finite historical exchange rates", () => {
    expect(validateHistoricalRate("2500").toFixed()).toBe("2500");
    for (const rate of [null, undefined, "", "nope", "0", "-1", "Infinity"] as const) {
      expect(() => validateHistoricalRate(rate)).toThrow();
    }
  });

  it("converts transaction and base amounts for every supported convention", () => {
    expect(convertTransactionToBase("5000", "CFA", "USD", "2500", RateConvention.TRANSACTION_PER_BASE)).toBe(
      "2.000000"
    );
    expect(convertBaseToTransaction("2", "CFA", "USD", "2500", RateConvention.TRANSACTION_PER_BASE)).toBe(
      "5000.000000"
    );
    expect(convertTransactionToBase("12.5", "EUR", "USD", "1.2", RateConvention.BASE_PER_TRANSACTION)).toBe(
      "15.000000"
    );
    expect(convertBaseToTransaction("15", "EUR", "USD", "1.2", RateConvention.BASE_PER_TRANSACTION)).toBe("12.500000");
    expect(convertTransactionToBase("9.25", "USD", "USD", null, RateConvention.IDENTITY)).toBe("9.250000");
    expect(convertBaseToTransaction("9.25", "USD", "USD", null, RateConvention.IDENTITY)).toBe("9.250000");
    expect(() => convertTransactionToBase("1", "CFA", "USD", "2500", "BAD" as any)).toThrow("Unknown rate convention");
    expect(() => convertBaseToTransaction("1", "CFA", "USD", "2500", "BAD" as any)).toThrow("Unknown rate convention");
  });

  it("normalizes debit and credit entries while preserving historical base amounts", () => {
    const debit = normalizeVoucherEntryAmounts({
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      transactionDebitAmount: "5000",
      transactionCreditAmount: "0",
      historicalRate: "2500",
    });
    const credit = normalizeVoucherEntryAmounts({
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: "0",
      transactionCreditAmount: "3.5",
      historicalRate: null,
    });

    expect(debit).toMatchObject({
      transactionCurrency: "CFA",
      transactionDebitAmount: "5000.000000",
      baseDebitAmount: "2.000000",
      debitAmount: "2.000000",
      historicalExchangeRate: "2500.0000000000",
      rateConvention: RateConvention.TRANSACTION_PER_BASE,
    });
    expect(credit).toMatchObject({
      transactionCurrency: "USD",
      transactionCreditAmount: "3.500000",
      baseCreditAmount: "3.500000",
      historicalExchangeRate: "1.0000000000",
      rateConvention: RateConvention.IDENTITY,
    });

    expect(sumNormalizedEntries([debit, credit])).toEqual({
      totalBaseDebit: "2.000000",
      totalBaseCredit: "3.500000",
      totalTransactionDebit: "5000.000000",
      totalTransactionCredit: "3.500000",
    });
  });

  it("rejects negative, empty-sided, double-sided, and unresolved foreign voucher entries", () => {
    const base = {
      transactionCurrency: "CFA",
      baseCurrency: "USD",
      historicalRate: "2500",
    };
    expect(() =>
      normalizeVoucherEntryAmounts({ ...base, transactionDebitAmount: "-1", transactionCreditAmount: "0" })
    ).toThrow("transactionDebitAmount must be ≥ 0");
    expect(() =>
      normalizeVoucherEntryAmounts({ ...base, transactionDebitAmount: "0", transactionCreditAmount: "-1" })
    ).toThrow("transactionCreditAmount must be ≥ 0");
    expect(() =>
      normalizeVoucherEntryAmounts({ ...base, transactionDebitAmount: "1", transactionCreditAmount: "1" })
    ).toThrow("cannot have both debit");
    expect(() =>
      normalizeVoucherEntryAmounts({ ...base, transactionDebitAmount: "0", transactionCreditAmount: "0" })
    ).toThrow("must have either debit or credit");
    expect(() =>
      normalizeVoucherEntryAmounts({
        ...base,
        transactionDebitAmount: "1",
        transactionCreditAmount: "0",
        historicalRate: null,
      })
    ).toThrow("valid positive rate is required");
  });

  it("derives legacy identity and foreign transaction values and returns null when unresolved", () => {
    expect(
      resolveLegacyTransactionAmounts({
        existingTransactionCurrency: "USD",
        voucherCurrency: "USD",
        baseCurrency: "USD",
        storedDebitAmount: "4",
        storedCreditAmount: "0",
        voucherExchangeRate: null,
      })
    ).toBeNull();

    expect(
      resolveLegacyTransactionAmounts({
        existingTransactionCurrency: null,
        voucherCurrency: "USD",
        baseCurrency: "USD",
        storedDebitAmount: "4",
        storedCreditAmount: "0",
        voucherExchangeRate: null,
      })
    ).toMatchObject({ transactionCurrency: "USD", transactionDebitAmount: "4.000000", baseDebitAmount: "4.000000" });

    expect(
      resolveLegacyTransactionAmounts({
        existingTransactionCurrency: null,
        voucherCurrency: "CFA",
        baseCurrency: "USD",
        storedDebitAmount: "2",
        storedCreditAmount: "0",
        voucherExchangeRate: "2500",
      })
    ).toMatchObject({
      transactionCurrency: "CFA",
      transactionDebitAmount: "5000.000000",
      baseDebitAmount: "2.000000",
      historicalExchangeRate: "2500.0000000000",
    });

    for (const params of [
      { voucherCurrency: "BAD", baseCurrency: "USD", voucherExchangeRate: "1" },
      { voucherCurrency: "CFA", baseCurrency: "BAD", voucherExchangeRate: "1" },
      { voucherCurrency: "CFA", baseCurrency: "USD", voucherExchangeRate: null },
      { voucherCurrency: "CFA", baseCurrency: "USD", voucherExchangeRate: "0" },
    ]) {
      expect(
        resolveLegacyTransactionAmounts({
          existingTransactionCurrency: null,
          storedDebitAmount: "1",
          storedCreditAmount: "0",
          ...params,
        })
      ).toBeNull();
    }
  });

  it("classifies safe migrated and identity rows and unsafe unresolved legacy rows", () => {
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: "1",
        baseCreditAmount: null,
        transactionCurrency: "CFA",
        voucherCurrency: "CFA",
        baseCurrency: "USD",
      })
    ).toEqual({ safe: true, classification: "migrated" });
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: null,
        baseCreditAmount: null,
        transactionCurrency: null,
        voucherCurrency: "USD",
        baseCurrency: "USD",
      })
    ).toEqual({ safe: true, classification: "identity-usd" });
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: null,
        baseCreditAmount: null,
        transactionCurrency: "CFA",
        voucherCurrency: null,
        baseCurrency: "USD",
      })
    ).toMatchObject({ safe: false, classification: "unresolved-legacy" });
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: null,
        baseCreditAmount: null,
        transactionCurrency: "BAD",
        voucherCurrency: null,
        baseCurrency: "USD",
      })
    ).toMatchObject({
      safe: false,
      classification: "unresolved-legacy",
      reason: expect.stringContaining("Cannot determine"),
    });
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: null,
        baseCreditAmount: null,
        transactionCurrency: "USD",
        voucherCurrency: null,
        baseCurrency: "BAD",
      })
    ).toMatchObject({
      safe: false,
      classification: "unresolved-legacy",
      reason: expect.stringContaining("Unknown base currency"),
    });
  });

  it("bridges ERP rates to daybook USD-per-unit rates", () => {
    expect(erpRateToDaybookFxRateToUsd("USD", "USD", null)).toBe("1.0000000000");
    expect(erpRateToDaybookFxRateToUsd("CFA", "USD", "2500")).toBe("0.0004000000");
    // An unknown code is never bridged as a silent 1:1 rate (Zambia phase 2).
    expect(() => erpRateToDaybookFxRateToUsd("BAD", "USD", "2500")).toThrow("Unsupported currency code");
    expect(erpRateToDaybookFxRateToUsd("ZMW", "USD", "25")).toBe("0.0400000000");
    expect(() => erpRateToDaybookFxRateToUsd("CFA", "USD", "0")).toThrow("rate must be positive");
  });
});
