/** Currency journal aggregation and legacy read-only fallback utilities. */
import Decimal from "decimal.js";
import {
  _normalizedBrand,
  RateConvention,
  normalizeCurrencyCode,
  validateHistoricalRate,
  erpTransactionPerUsdToFactoryUsdPerUnit,
  InvalidExchangeRateError,
  type NormalizedEntryAmounts,
} from "./currencyAmountsCore";

export * from "./currencyAmountsCore";

/**
 * Sum base amounts for a normalized journal. Legacy transaction totals below
 * remain for backward compatibility but are NOT meaningful if the entries use
 * more than one native currency. Use groupNormalizedTransactionAmountsByCurrency
 * when displaying or reconciling native amounts from a mixed-currency journal.
 */
export function sumNormalizedEntries(entries: NormalizedEntryAmounts[]): {
  totalBaseDebit: string;
  totalBaseCredit: string;
  totalTransactionDebit: string;
  totalTransactionCredit: string;
} {
  let totalBaseDebit = new Decimal(0);
  let totalBaseCredit = new Decimal(0);
  let totalTxDebit = new Decimal(0);
  let totalTxCredit = new Decimal(0);

  for (const e of entries) {
    totalBaseDebit = totalBaseDebit.plus(e.baseDebitAmount);
    totalBaseCredit = totalBaseCredit.plus(e.baseCreditAmount);
    totalTxDebit = totalTxDebit.plus(e.transactionDebitAmount);
    totalTxCredit = totalTxCredit.plus(e.transactionCreditAmount);
  }

  return {
    totalBaseDebit: totalBaseDebit.toDecimalPlaces(6).toFixed(6),
    totalBaseCredit: totalBaseCredit.toDecimalPlaces(6).toFixed(6),
    totalTransactionDebit: totalTxDebit.toDecimalPlaces(6).toFixed(6),
    totalTransactionCredit: totalTxCredit.toDecimalPlaces(6).toFixed(6),
  };
}

/**
 * Separately total the original transaction amounts for each actual currency.
 * Never add ZMW and USD (or CFA and USD) as if they were one native balance.
 * Every amount stays in its own currency and at its historical posting value.
 */
export function groupNormalizedTransactionAmountsByCurrency(
  entries: NormalizedEntryAmounts[]
): Record<string, { debit: string; credit: string }> {
  const groups = new Map<string, { debit: Decimal; credit: Decimal }>();
  for (const entry of entries) {
    const currency = normalizeCurrencyCode(entry.transactionCurrency);
    const totals = groups.get(currency) ?? { debit: new Decimal(0), credit: new Decimal(0) };
    totals.debit = totals.debit.plus(entry.transactionDebitAmount);
    totals.credit = totals.credit.plus(entry.transactionCreditAmount);
    groups.set(currency, totals);
  }
  const result: Record<string, { debit: string; credit: string }> = {};
  for (const [currency, totals] of groups) {
    result[currency] = {
      debit: totals.debit.toDecimalPlaces(6).toFixed(6),
      credit: totals.credit.toDecimalPlaces(6).toFixed(6),
    };
  }
  return result;
}

/**
 * Derive transaction-currency amounts for legacy voucher_entries rows that
 * predate this schema change.  Used by read paths (GET voucher) and the
 * repair script — never persists anything automatically.
 *
 * Classification:
 *  - If transactionCurrency is already populated: row is already repaired.
 *  - If voucher currency === baseCurrency (USD): transaction = existing debit/credit.
 *  - If voucher currency is non-USD and the voucher's stored rate is valid:
 *      transactionDebit = baseDebit * rate   (inverse of TRANSACTION_PER_BASE)
 *  - Otherwise: returns null — caller must flag as "manual review required".
 *
 * IMPORTANT: this function does NOT persist anything. It only produces a
 * preview for dry-run and read paths.
 */
export function resolveLegacyTransactionAmounts(params: {
  existingTransactionCurrency: string | null | undefined;
  voucherCurrency: string | null | undefined;
  baseCurrency: string;
  storedDebitAmount: string | null | undefined;
  storedCreditAmount: string | null | undefined;
  voucherExchangeRate: string | null | undefined;
}): NormalizedEntryAmounts | null {
  const {
    existingTransactionCurrency,
    voucherCurrency,
    baseCurrency,
    storedDebitAmount,
    storedCreditAmount,
    voucherExchangeRate,
  } = params;

  // Already repaired — return as-is (caller should read from DB columns directly)
  if (existingTransactionCurrency) return null;

  const baseDebit = new Decimal(storedDebitAmount ?? 0);
  const baseCredit = new Decimal(storedCreditAmount ?? 0);

  let txCcy: string;
  try {
    txCcy = normalizeCurrencyCode(voucherCurrency || baseCurrency);
  } catch {
    return null; // unknown currency — manual review
  }

  let baseCcy: string;
  try {
    baseCcy = normalizeCurrencyCode(baseCurrency);
  } catch {
    return null;
  }

  if (txCcy === baseCcy) {
    // USD-only voucher — transaction = stored amounts
    const convention = RateConvention.IDENTITY;
    const rateStr = "1.0000000000";
    const debitStr = baseDebit.toDecimalPlaces(6).toFixed(6);
    const creditStr = baseCredit.toDecimalPlaces(6).toFixed(6);
    return {
      [_normalizedBrand]: true,
      transactionCurrency: txCcy,
      transactionDebitAmount: debitStr,
      transactionCreditAmount: creditStr,
      baseDebitAmount: debitStr,
      baseCreditAmount: creditStr,
      historicalExchangeRate: rateStr,
      rateConvention: convention,
      debitAmount: debitStr,
      creditAmount: creditStr,
    } as NormalizedEntryAmounts;
  }

  // Non-USD: need a valid rate to derive transaction amounts
  if (!voucherExchangeRate) return null;

  let rate: Decimal;
  try {
    rate = validateHistoricalRate(voucherExchangeRate, "legacy resolution rate");
  } catch {
    return null; // invalid rate — manual review
  }

  // Convention = TRANSACTION_PER_BASE:
  //   stored debit/credit are assumed to be the historical base (USD) amounts
  //   transaction amounts = base * rate
  const txDebit = baseDebit.times(rate);
  const txCredit = baseCredit.times(rate);

  return {
    [_normalizedBrand]: true,
    transactionCurrency: txCcy,
    transactionDebitAmount: txDebit.toDecimalPlaces(6).toFixed(6),
    transactionCreditAmount: txCredit.toDecimalPlaces(6).toFixed(6),
    baseDebitAmount: baseDebit.toDecimalPlaces(6).toFixed(6),
    baseCreditAmount: baseCredit.toDecimalPlaces(6).toFixed(6),
    historicalExchangeRate: rate.toDecimalPlaces(10).toFixed(10),
    rateConvention: RateConvention.TRANSACTION_PER_BASE,
    debitAmount: baseDebit.toDecimalPlaces(6).toFixed(6),
    creditAmount: baseCredit.toDecimalPlaces(6).toFixed(6),
  } as NormalizedEntryAmounts;
}

/**
 * Classify a voucher_entry row for historical-fallback read paths.
 *
 * The `COALESCE(base_debit_amount, debit_amount)` SQL fallback used throughout
 * reporting queries is safe only for certain row classifications:
 *
 *   "migrated"          — base_debit_amount IS NOT NULL → safe to use base_debit_amount
 *   "identity-usd"      — txCurrency = baseCurrency → debit_amount stores correct base
 *   "unresolved-legacy" — non-base currency, base_debit_amount IS NULL → unsafe;
 *                         debit_amount may be a raw CFA transaction amount, not a USD base
 *
 * Callers that need to handle unresolved-legacy rows should flag them for backfill
 * or display a "data unresolved" indicator in the UI.
 *
 * NOTE: This is a read-only classification helper. It never persists anything.
 */
export function classifyVoucherEntryFallback(params: {
  baseDebitAmount: string | null | undefined;
  baseCreditAmount: string | null | undefined;
  transactionCurrency: string | null | undefined;
  voucherCurrency: string | null | undefined;
  baseCurrency: string;
}): { safe: boolean; classification: "migrated" | "identity-usd" | "unresolved-legacy"; reason?: string } {
  const { baseDebitAmount, baseCreditAmount, transactionCurrency, voucherCurrency, baseCurrency } = params;

  // Already migrated → safe; caller should use base_debit_amount directly.
  if (baseDebitAmount != null || baseCreditAmount != null) {
    return { safe: true, classification: "migrated" };
  }

  let txCcy: string;
  let baseCcy: string;

  try {
    txCcy = normalizeCurrencyCode(transactionCurrency || voucherCurrency || baseCurrency);
  } catch {
    return {
      safe: false,
      classification: "unresolved-legacy",
      reason: `Cannot determine transaction currency from: transactionCurrency=${transactionCurrency}, voucherCurrency=${voucherCurrency}`,
    };
  }

  try {
    baseCcy = normalizeCurrencyCode(baseCurrency);
  } catch {
    return {
      safe: false,
      classification: "unresolved-legacy",
      reason: `Unknown base currency: ${baseCurrency}`,
    };
  }

  if (txCcy === baseCcy) {
    // USD-in-USD: stored debit/credit are the historical base amounts → safe.
    return { safe: true, classification: "identity-usd" };
  }

  // Non-base currency with no base_debit_amount → unknown denomination.
  return {
    safe: false,
    classification: "unresolved-legacy",
    reason: `${txCcy} entry with no base_debit_amount — COALESCE fallback returns raw amount in unknown denomination (could be CFA tx amount or legacy USD base). Run backfill to resolve.`,
  };
}

/**
 * Compute the fxRateToUsd value for storage in factory_daybook_entries.
 *
 * factory_daybook_entries.fx_rate_to_usd stores USD per foreign-currency unit
 * (i.e. how many USD you get for 1 unit of the foreign currency).
 *
 * The ERP voucher header stores exchangeRate as CFA per USD (TRANSACTION_PER_BASE).
 * Those are OPPOSITE conventions — this function bridges them:
 *
 *   fxRateToUsd = 1 / cfaPerUsd
 *
 * For USD vouchers: fxRateToUsd = 1 (no conversion).
 */
export function erpRateToDaybookFxRateToUsd(
  transactionCurrency: string,
  baseCurrency: string,
  erpExchangeRate: string | number | null | undefined
): string {
  const txCcy = normalizeCurrencyCode(transactionCurrency);
  const baseCcy = normalizeCurrencyCode(baseCurrency);
  if (baseCcy !== "USD") {
    throw new InvalidExchangeRateError("Factory daybook fxRateToUsd requires USD as the base currency.");
  }
  if (txCcy === baseCcy) return "1.0000000000";

  return erpTransactionPerUsdToFactoryUsdPerUnit(erpExchangeRate);
}
