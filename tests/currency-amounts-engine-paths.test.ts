/**
 * Edge paths of the shared currency engine that the posting-path suites do not
 * reach: rate inversion in both directions and its overflow guard, the
 * IDENTITY/BASE_PER_TRANSACTION/unknown conventions of both converters,
 * non-finite inputs, per-currency grouping of native amounts, and the manual
 * review exits of the legacy resolver. Every assertion is on returned values or
 * thrown errors; nothing here reads source text.
 */
import { describe, expect, it } from "vitest";

import {
  InvalidExchangeRateError,
  RateConvention,
  classifyVoucherEntryFallback,
  convertBaseToTransaction,
  convertTransactionToBase,
  erpRateToDaybookFxRateToUsd,
  erpTransactionPerUsdToFactoryUsdPerUnit,
  factoryUsdPerUnitToErpTransactionPerUsd,
  groupNormalizedTransactionAmountsByCurrency,
  normalizeVoucherEntryAmounts,
  resolveLegacyTransactionAmounts,
  type NormalizeVoucherEntryAmountsInput,
  type RateConventionValue,
} from "../server/services/accounting/currencyAmounts";

const UNKNOWN_CONVENTION = "UNKNOWN" as RateConventionValue;

describe("rate inversion between the ERP and Factory conventions", () => {
  it("inverts in both directions at ten decimals", () => {
    expect(erpTransactionPerUsdToFactoryUsdPerUnit("25")).toBe("0.0400000000");
    expect(factoryUsdPerUnitToErpTransactionPerUsd("0.04")).toBe("25.0000000000");
    expect(factoryUsdPerUnitToErpTransactionPerUsd(0.0018)).toBe("555.5555555556");
  });

  it("refuses a rate whose reciprocal cannot be stored at ten decimals", () => {
    expect(() => erpTransactionPerUsdToFactoryUsdPerUnit("100000000000")).toThrow(InvalidExchangeRateError);
    expect(() => factoryUsdPerUnitToErpTransactionPerUsd("1e12")).toThrow(/reciprocal is too small/);
  });

  it("rejects a non-USD accounting base for the daybook bridge", () => {
    expect(() => erpRateToDaybookFxRateToUsd("USD", "CFA", "600")).toThrow(InvalidExchangeRateError);
    expect(() => erpRateToDaybookFxRateToUsd("USD", "CFA", "600")).toThrow(/requires USD as the base currency/);
  });
});

describe("converter conventions", () => {
  it("refuses IDENTITY for a foreign pair in both directions", () => {
    expect(() => convertTransactionToBase("250", "ZMW", "USD", null, RateConvention.IDENTITY)).toThrow(
      /IDENTITY is invalid for ZMW->USD/
    );
    expect(() => convertBaseToTransaction("10", "ZMW", "USD", null, RateConvention.IDENTITY)).toThrow(
      /IDENTITY is invalid for USD->ZMW/
    );
  });

  it("applies BASE_PER_TRANSACTION as a multiply then divide", () => {
    expect(convertTransactionToBase("10", "EUR", "USD", "1.1", RateConvention.BASE_PER_TRANSACTION)).toBe("11.000000");
    expect(convertBaseToTransaction("11", "EUR", "USD", "1.1", RateConvention.BASE_PER_TRANSACTION)).toBe("10.000000");
  });

  it("rejects an unknown convention and non-finite amounts", () => {
    expect(() => convertTransactionToBase("10", "ZMW", "USD", "25", UNKNOWN_CONVENTION)).toThrow(
      /Unknown rate convention/
    );
    expect(() => convertBaseToTransaction("10", "ZMW", "USD", "25", UNKNOWN_CONVENTION)).toThrow(
      /Unknown rate convention/
    );
    expect(() =>
      convertTransactionToBase(Number.POSITIVE_INFINITY, "ZMW", "USD", "25", RateConvention.TRANSACTION_PER_BASE)
    ).toThrow(/transactionAmount must be finite/);
    expect(() =>
      convertBaseToTransaction(Number.NEGATIVE_INFINITY, "ZMW", "USD", "25", RateConvention.TRANSACTION_PER_BASE)
    ).toThrow(/baseAmount must be finite/);
  });
});

describe("normalizeVoucherEntryAmounts edge inputs", () => {
  it("treats a missing side as zero and rejects non-finite sides", () => {
    const missingCredit = {
      transactionCurrency: "ZMW",
      baseCurrency: "USD",
      transactionDebitAmount: "250",
      transactionCreditAmount: undefined,
      historicalRate: "25",
    } as unknown as NormalizeVoucherEntryAmountsInput;
    const normalized = normalizeVoucherEntryAmounts(missingCredit);
    expect(normalized.transactionCreditAmount).toBe("0.000000");
    expect(normalized.baseDebitAmount).toBe("10.000000");

    const missingDebit = {
      transactionCurrency: "USD",
      baseCurrency: "USD",
      transactionDebitAmount: undefined,
      transactionCreditAmount: "7.5",
      historicalRate: null,
    } as unknown as NormalizeVoucherEntryAmountsInput;
    expect(normalizeVoucherEntryAmounts(missingDebit).transactionDebitAmount).toBe("0.000000");

    expect(() =>
      normalizeVoucherEntryAmounts({
        transactionCurrency: "ZMW",
        baseCurrency: "USD",
        transactionDebitAmount: Number.POSITIVE_INFINITY,
        transactionCreditAmount: "0",
        historicalRate: "25",
      })
    ).toThrow(/must be finite/);
  });
});

describe("groupNormalizedTransactionAmountsByCurrency", () => {
  it("totals each native currency separately at historical values", () => {
    const entries = [
      normalizeVoucherEntryAmounts({
        transactionCurrency: "ZMW",
        baseCurrency: "USD",
        transactionDebitAmount: "250",
        transactionCreditAmount: "0",
        historicalRate: "25",
      }),
      normalizeVoucherEntryAmounts({
        transactionCurrency: "zmw",
        baseCurrency: "USD",
        transactionDebitAmount: "0",
        transactionCreditAmount: "100.5",
        historicalRate: "25",
      }),
      normalizeVoucherEntryAmounts({
        transactionCurrency: "USD",
        baseCurrency: "USD",
        transactionDebitAmount: "0",
        transactionCreditAmount: "6",
        historicalRate: null,
      }),
      normalizeVoucherEntryAmounts({
        transactionCurrency: "XOF",
        baseCurrency: "USD",
        transactionDebitAmount: "1200",
        transactionCreditAmount: "0",
        historicalRate: "600",
      }),
    ];
    expect(groupNormalizedTransactionAmountsByCurrency(entries)).toEqual({
      ZMW: { debit: "250.000000", credit: "100.500000" },
      USD: { debit: "0.000000", credit: "6.000000" },
      CFA: { debit: "1200.000000", credit: "0.000000" },
    });
    expect(groupNormalizedTransactionAmountsByCurrency([])).toEqual({});
  });
});

describe("legacy resolution and fallback classification exits", () => {
  it("returns null for repaired rows and unknown currencies", () => {
    const base = {
      storedDebitAmount: "10",
      storedCreditAmount: "0",
      voucherExchangeRate: "600",
    };
    expect(
      resolveLegacyTransactionAmounts({
        ...base,
        existingTransactionCurrency: "CFA",
        voucherCurrency: "CFA",
        baseCurrency: "USD",
      })
    ).toBeNull();
    expect(
      resolveLegacyTransactionAmounts({
        ...base,
        existingTransactionCurrency: null,
        voucherCurrency: "ABC",
        baseCurrency: "USD",
      })
    ).toBeNull();
    expect(
      resolveLegacyTransactionAmounts({
        ...base,
        existingTransactionCurrency: null,
        voucherCurrency: "USD",
        baseCurrency: "ABC",
      })
    ).toBeNull();
  });

  it("falls back to the base currency when a row names no currency at all", () => {
    expect(
      classifyVoucherEntryFallback({
        baseDebitAmount: null,
        baseCreditAmount: null,
        transactionCurrency: null,
        voucherCurrency: null,
        baseCurrency: "USD",
      })
    ).toEqual({ safe: true, classification: "identity-usd" });
  });
});
