import Decimal from "decimal.js";
import { normalizeCurrencyCode, validateHistoricalRate } from "./currencyAmounts";

export interface OpeningBalanceCurrencyInput {
  openingBalance: string | number | null | undefined;
  openingBalanceCurrency: string | null | undefined;
  openingBalanceHistoricalRate?: string | number | null;
  openingBalanceBaseAmount?: string | number | null;
  baseCurrency?: string;
}

export interface NormalizedOpeningBalanceCurrency {
  openingBalanceNativeAmount: string;
  openingBalanceCurrency: string | null;
  openingBalanceHistoricalRate: string | null;
  openingBalanceBaseAmount: string;
}

/**
 * Normalizes an unsigned opening-balance magnitude. Debit/credit direction is
 * stored separately in openingBalanceSide and must not be applied here.
 *
 * openingBalanceNativeAmount preserves what the user entered. Legacy
 * openingBalance columns should store openingBalanceBaseAmount so older reports
 * continue reading historical company-base values.
 */
export function normalizeOpeningBalanceCurrency(input: OpeningBalanceCurrencyInput): NormalizedOpeningBalanceCurrency {
  const baseCurrency = normalizeCurrencyCode(input.baseCurrency || "USD");
  const amount = new Decimal(input.openingBalance ?? 0);

  if (!amount.isFinite() || amount.lt(0)) {
    throw new Error("Opening balance must be a finite non-negative amount.");
  }

  if (amount.isZero()) {
    return {
      openingBalanceNativeAmount: "0.000000",
      openingBalanceCurrency: null,
      openingBalanceHistoricalRate: null,
      openingBalanceBaseAmount: "0.000000",
    };
  }

  if (!input.openingBalanceCurrency) {
    throw new Error("A non-zero opening balance requires its currency.");
  }

  const currency = normalizeCurrencyCode(input.openingBalanceCurrency);
  let historicalRate: Decimal;
  let computedBase: Decimal;

  if (currency === baseCurrency) {
    historicalRate = new Decimal(1);
    computedBase = amount;
  } else if ((currency === "CFA" || currency === "ZMW") && baseCurrency === "USD") {
    historicalRate = validateHistoricalRate(
      input.openingBalanceHistoricalRate,
      `${currency} opening-balance historical rate`
    );
    computedBase = amount.div(historicalRate);
  } else {
    throw new Error(
      `Opening-balance conversion for ${currency}/${baseCurrency} is not configured. ` +
        "Provide a supported historical conversion before saving the account."
    );
  }

  if (
    input.openingBalanceBaseAmount !== null &&
    input.openingBalanceBaseAmount !== undefined &&
    input.openingBalanceBaseAmount !== ""
  ) {
    const suppliedBase = new Decimal(input.openingBalanceBaseAmount);
    if (!suppliedBase.isFinite() || suppliedBase.lt(0)) {
      throw new Error("Opening-balance base amount must be a finite non-negative amount.");
    }
    if (!suppliedBase.eq(computedBase.toDecimalPlaces(6))) {
      throw new Error(
        `Opening-balance base amount does not match the native amount and historical rate. ` +
          `Expected ${computedBase.toDecimalPlaces(6).toFixed(6)} ${baseCurrency}.`
      );
    }
  }

  return {
    openingBalanceNativeAmount: amount.toDecimalPlaces(6).toFixed(6),
    openingBalanceCurrency: currency,
    openingBalanceHistoricalRate: historicalRate.toDecimalPlaces(10).toFixed(10),
    openingBalanceBaseAmount: computedBase.toDecimalPlaces(6).toFixed(6),
  };
}
