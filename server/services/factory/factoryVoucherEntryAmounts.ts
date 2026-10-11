import Decimal from "decimal.js";

import { RateConvention } from "../accounting/currencyAmounts";
import { resolveStoredFxRateOrThrow } from "./currencyConversion";

export interface FactoryVoucherEntryAmounts {
  transactionCurrency: string;
  transactionDebitAmount: string;
  transactionCreditAmount: string;
  baseDebitAmount: string;
  baseCreditAmount: string;
  historicalExchangeRate: string;
  rateConvention: "IDENTITY" | "BASE_PER_TRANSACTION";
  debitAmount: string;
  creditAmount: string;
}

function decimal(value: string | number, label: string): Decimal {
  try {
    const parsed = new Decimal(value);
    if (!parsed.isFinite()) throw new Error();
    return parsed;
  } catch {
    throw new Error(`${label} must be a finite number.`);
  }
}

/**
 * Normalize a factory voucher entry without changing the factory FX convention.
 *
 * Factory rates are stored as base USD per one transaction-currency unit, so a
 * foreign transaction is converted with: base USD = transaction amount × rate.
 */
export function normalizeFactoryVoucherEntryAmounts(params: {
  transactionCurrency: string;
  transactionDebitAmount: string | number;
  transactionCreditAmount: string | number;
  fxRateToUsd: string | number;
}): FactoryVoucherEntryAmounts {
  const transactionCurrency = String(params.transactionCurrency || "")
    .trim()
    .toUpperCase();
  if (!/^[A-Z]{3}$/.test(transactionCurrency)) {
    throw new Error("Factory voucher transaction currency must be a three-letter code.");
  }

  const transactionDebit = decimal(params.transactionDebitAmount, "transactionDebitAmount");
  const transactionCredit = decimal(params.transactionCreditAmount, "transactionCreditAmount");
  if (transactionDebit.lt(0) || transactionCredit.lt(0)) {
    throw new Error("Factory voucher entry amounts cannot be negative.");
  }

  const debitPositive = transactionDebit.gt(0);
  const creditPositive = transactionCredit.gt(0);
  if (debitPositive === creditPositive) {
    throw new Error("A factory voucher entry must have exactly one positive debit or credit side.");
  }

  const identity = transactionCurrency === "USD";
  const fxRate = identity ? new Decimal(1) : decimal(params.fxRateToUsd, "fxRateToUsd");
  if (fxRate.lte(0)) {
    throw new Error("Factory voucher FX rate must be positive.");
  }

  // Computed from the amounts and rate as stored (6 and 10 places), which is how
  // the voucher-entry trigger checks them; a rate with more places would
  // otherwise give a base the trigger rejects.
  const storedRate = fxRate.toDecimalPlaces(10);
  const baseDebit = identity ? transactionDebit : transactionDebit.toDecimalPlaces(6).times(storedRate);
  const baseCredit = identity ? transactionCredit : transactionCredit.toDecimalPlaces(6).times(storedRate);
  const baseDebitAmount = baseDebit.toDecimalPlaces(6).toFixed(6);
  const baseCreditAmount = baseCredit.toDecimalPlaces(6).toFixed(6);

  return {
    transactionCurrency,
    transactionDebitAmount: transactionDebit.toDecimalPlaces(6).toFixed(6),
    transactionCreditAmount: transactionCredit.toDecimalPlaces(6).toFixed(6),
    baseDebitAmount,
    baseCreditAmount,
    historicalExchangeRate: storedRate.toFixed(10),
    rateConvention: identity ? "IDENTITY" : "BASE_PER_TRANSACTION",
    debitAmount: baseDebitAmount,
    creditAmount: baseCreditAmount,
  };
}

/**
 * Normalize a factory voucher entry.
 *
 * Factory stores fxRateToUsd in BASE_PER_TRANSACTION convention (USD per
 * foreign unit), and the entry keeps that rate and convention as its historical
 * rate, so the voucher-entry trigger reproduces the base exactly.
 *
 * Factory supports currencies such as AUD/LBP that are valid in the factory
 * UI but are not part of the narrower general-ERP currency whitelist. Do the
 * factory conversion here using the already-resolved factory FX rate instead
 * of sending the currency through that unrelated whitelist.
 */
export function normFactoryEntry(
  transactionCurrency: string | null | undefined,
  debit: string | number,
  credit: string | number,
  fxRateToUsdFactory: number | string | null | undefined
) {
  const ccy = (transactionCurrency || "USD").trim().toUpperCase();
  const txDebit = new Decimal(debit ?? 0);
  const txCredit = new Decimal(credit ?? 0);

  if (txDebit.lt(0)) throw new Error("transactionDebitAmount must be ≥ 0");
  if (txCredit.lt(0)) throw new Error("transactionCreditAmount must be ≥ 0");

  const debitPositive = txDebit.gt(0);
  const creditPositive = txCredit.gt(0);
  if (debitPositive && creditPositive) {
    throw new Error(
      `A voucher entry cannot have both debit (${txDebit.toFixed()}) and credit (${txCredit.toFixed()}) > 0.`
    );
  }
  if (!debitPositive && !creditPositive) {
    throw new Error("A posted voucher entry must have either debit or credit > 0.");
  }

  let baseDebit: Decimal;
  let baseCredit: Decimal;
  let historicalRate: string;
  let rateConvention: (typeof RateConvention)[keyof typeof RateConvention];

  if (ccy === "USD") {
    baseDebit = txDebit;
    baseCredit = txCredit;
    historicalRate = "1.0000000000";
    rateConvention = RateConvention.IDENTITY;
  } else {
    if (fxRateToUsdFactory === null || fxRateToUsdFactory === undefined || fxRateToUsdFactory === "") {
      throw new Error(`Factory fxRateToUsd for ${ccy} is required.`);
    }

    let factoryRate: Decimal;
    try {
      factoryRate = new Decimal(fxRateToUsdFactory);
    } catch {
      throw new Error(`Factory fxRateToUsd for ${ccy} must be numeric.`);
    }
    if (!factoryRate.isFinite() || factoryRate.lte(0)) {
      throw new Error(`Factory fxRateToUsd for ${ccy} must be a positive finite rate.`);
    }

    // Factory: USD = foreign amount × fxRateToUsd, stored as BASE_PER_TRANSACTION
    // with the rate as the voucher-entry trigger reads it (numeric(20, 10)).
    // The inverse rate (TRANSACTION_PER_BASE) used to be stored instead; rounded
    // to 10 places it reproduced the base only for small amounts, so the trigger
    // refused larger lines (250,000 at 0.6543219: 163580.475000 vs .475003).
    const storedRate = factoryRate.toDecimalPlaces(10);
    baseDebit = txDebit.toDecimalPlaces(6).times(storedRate);
    baseCredit = txCredit.toDecimalPlaces(6).times(storedRate);
    historicalRate = storedRate.toFixed(10);
    rateConvention = RateConvention.BASE_PER_TRANSACTION;
  }

  const transactionDebitAmount = txDebit.toDecimalPlaces(6).toFixed(6);
  const transactionCreditAmount = txCredit.toDecimalPlaces(6).toFixed(6);
  const baseDebitAmount = baseDebit.toDecimalPlaces(6).toFixed(6);
  const baseCreditAmount = baseCredit.toDecimalPlaces(6).toFixed(6);

  return {
    transactionCurrency: ccy,
    transactionDebitAmount,
    transactionCreditAmount,
    baseDebitAmount,
    baseCreditAmount,
    historicalExchangeRate: historicalRate,
    rateConvention,
    debitAmount: baseDebitAmount,
    creditAmount: baseCreditAmount,
  };
}

/**
 * The USD-per-unit rate for a container's freight. Freight in a third currency
 * (neither USD nor the container's) has its own rate on the container; it used
 * to be posted at 1, so AUD freight on a EUR container was booked as if it were
 * USD. A missing rate is refused (UnresolvedExchangeRateError), never assumed.
 */
export function containerFreightFxRateToUsd(container: {
  currencyCode: string | null;
  fxRateToUsd: string | null;
  fxRateConfirmed: boolean | null;
  freightCurrencyCode: string | null;
  freightFxRateToUsd: string | null;
  freightFxRateConfirmed: boolean | null;
}): number {
  const containerCcy = container.currencyCode || "USD";
  const freightCcy = container.freightCurrencyCode || containerCcy;
  if (freightCcy === "USD") return 1;
  if (freightCcy === containerCcy) {
    return resolveStoredFxRateOrThrow(containerCcy, container.fxRateToUsd, container.fxRateConfirmed ?? undefined);
  }
  return resolveStoredFxRateOrThrow(
    freightCcy,
    container.freightFxRateToUsd,
    container.freightFxRateConfirmed ?? undefined
  );
}

// Wave 17 (D): factoryEntryAmountsOrLegacy (the legacy shape — native amount in
// the USD columns — when a non-USD document had no rate) is gone. Its writers
// require a confirmed dated rate (factoryDocumentFxRate.ts) and post
// normFactoryEntry, and the currency trigger refuses that shape (v2).
