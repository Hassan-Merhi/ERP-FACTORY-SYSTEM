/**
 * server/services/accounting/currencyAmounts.ts
 *
 * Phase 2 — Shared Currency Domain Service
 *
 * General ERP accounting currency helpers.
 *
 * RATE CONVENTION — general ERP vouchers (distinct from factory costing):
 *
 *   For a USD-base company with CFA transaction currency:
 *     exchangeRate = CFA per 1 USD   (TRANSACTION_PER_BASE)
 *     baseUsd      = cfaAmount / exchangeRate
 *     cfaAmount    = baseUsd  * exchangeRate
 *
 * The factory raw-material module uses the OPPOSITE convention
 * (fxRateToUsd = USD per foreign unit, multiplication converts to USD).
 * NEVER pass a TRANSACTION_PER_BASE rate into factory costing helpers,
 * and NEVER pass a factory fxRateToUsd rate into these helpers.
 */

import Decimal from "decimal.js";
import { HttpError } from "../../lib/httpError";
import { isSupportedAccountingCurrency, normalizeAccountingCurrencyAlias } from "@shared/currencyCatalog";

// ─── Rate-convention enum ────────────────────────────────────────────────────

export const RateConvention = {
  /** Transaction currency IS base currency (e.g. USD voucher in a USD-base company). */
  IDENTITY: "IDENTITY",
  /**
   * exchangeRate = number of transaction-currency units per 1 base unit.
   * e.g. CFA per USD:  baseUsd = cfaAmount / exchangeRate
   */
  TRANSACTION_PER_BASE: "TRANSACTION_PER_BASE",
  /**
   * exchangeRate = number of base-currency units per 1 transaction unit.
   * (Reserved; not used for current ERP flows.)
   */
  BASE_PER_TRANSACTION: "BASE_PER_TRANSACTION",
} as const;

export type RateConventionValue = (typeof RateConvention)[keyof typeof RateConvention];

// ─── Branded normalized-entry type ──────────────────────────────────────────

/**
 * Opaque brand so callers cannot confuse a raw (un-normalized) entry object
 * with one that has passed through normalizeVoucherEntryAmounts().
 *
 * Use this type as the accepted parameter wherever only normalized entries
 * should be accepted.
 */
// Runtime Symbol — must be a real value (not `declare const`) so it exists
// both in TypeScript and at JS execution time (tests, compiled output).
const _normalizedBrand = Symbol("normalizedEntryAmounts");

export interface NormalizedEntryAmounts {
  readonly [_normalizedBrand]: true;
  /** Currency code of the original transaction (e.g. "CFA", "USD"). Uses the project alias "CFA", not ISO "XOF". */
  readonly transactionCurrency: string;
  /** Original transaction-currency debit (≥0). String for decimal precision. */
  readonly transactionDebitAmount: string;
  /** Original transaction-currency credit (≥0). */
  readonly transactionCreditAmount: string;
  /** Historical base-currency (USD) debit amount. */
  readonly baseDebitAmount: string;
  /** Historical base-currency (USD) credit amount. */
  readonly baseCreditAmount: string;
  /** The historical exchange rate stored at posting time. */
  readonly historicalExchangeRate: string;
  /** The rate convention used (IDENTITY | TRANSACTION_PER_BASE | BASE_PER_TRANSACTION). */
  readonly rateConvention: RateConventionValue;
  /**
   * Backward-compatible debitAmount (= baseDebitAmount).
   * Always stores the historical base (USD) value so legacy queries remain correct.
   */
  readonly debitAmount: string;
  /**
   * Backward-compatible creditAmount (= baseCreditAmount).
   */
  readonly creditAmount: string;
}

// ─── Supported currencies ────────────────────────────────────────────────────

// Currency availability and labels are shared with the client via @shared/currencyCatalog.

// ─── Public helpers ──────────────────────────────────────────────────────────

/**
 * Normalise a currency code: upper-cases it and keeps "CFA" as the project identifier.
 *
 * This project uses "CFA" (not ISO-4217 "XOF") everywhere: in the database,
 * in APIs, in screen labels, and in exchange-rate records.  Incoming "XOF"
 * (from external feeds or user input) is normalised to "CFA" at this boundary.
 * The other direction ("CFA" → "XOF") is deliberately NOT performed.
 *
 * Throws for unsupported or empty codes.
 */
export function normalizeCurrencyCode(code: string | null | undefined): string {
  if (!code || typeof code !== "string") {
    throw new Error("Currency code must be a non-empty string.");
  }
  const upper = normalizeAccountingCurrencyAlias(code);
  // XOF retains the legacy project identifier CFA; ZMW remains ZMW.
  if (!isSupportedAccountingCurrency(upper)) {
    throw new Error(`Unsupported currency code: "${upper}". Add it to currencyAmounts.ts if needed.`);
  }
  return upper;
}

/**
 * A missing or invalid exchange rate on the request. Routes answer it with 400
 * so the user sees the message and can enter a rate, instead of a server error.
 */
export class InvalidExchangeRateError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "InvalidExchangeRateError";
  }
}

/**
 * Validate a historical exchange rate.
 * Returns the rate as a Decimal. Throws for zero, negative, NaN, Infinity,
 * or non-numeric strings. Never silently defaults to 1.
 */
export function validateHistoricalRate(rate: string | number | null | undefined, context = "exchange rate"): Decimal {
  if (rate === null || rate === undefined || rate === "") {
    throw new InvalidExchangeRateError(`${context}: a valid positive rate is required; got null/undefined/empty.`);
  }
  let d: Decimal;
  try {
    d = new Decimal(rate);
  } catch {
    throw new InvalidExchangeRateError(`${context}: "${rate}" is not a valid numeric rate.`);
  }
  if (!d.isFinite()) {
    throw new InvalidExchangeRateError(`${context}: rate must be finite; got "${rate}".`);
  }
  if (d.lte(0)) {
    throw new InvalidExchangeRateError(`${context}: rate must be positive; got "${rate}".`);
  }
  return d;
}

/**
 * Convert between ERP foreign units per USD and Factory USD per foreign unit.
 * Rates must come from the correct company and transaction date; no rate is
 * looked up, assumed, or substituted here.
 */
function invertPositiveRate(rate: string | number | null | undefined, context: string): string {
  const original = validateHistoricalRate(rate, context);
  const inverted = new Decimal(1).div(original).toDecimalPlaces(10);
  if (!inverted.isFinite() || inverted.lte(0)) {
    throw new InvalidExchangeRateError(`${context}: reciprocal is too small to store at 10 decimals.`);
  }
  return inverted.toFixed(10);
}

/** ERP: foreign units per 1 USD -> Factory: USD per foreign unit. */
export function erpTransactionPerUsdToFactoryUsdPerUnit(rate: string | number | null | undefined): string {
  return invertPositiveRate(rate, "ERP transaction-per-USD rate");
}

/** Factory: USD per foreign unit -> ERP: foreign units per 1 USD. */
export function factoryUsdPerUnitToErpTransactionPerUsd(rate: string | number | null | undefined): string {
  return invertPositiveRate(rate, "Factory USD-per-unit rate");
}

/**
 * Convert a transaction-currency amount to base currency (USD).
 *
 * For TRANSACTION_PER_BASE (CFA per USD):
 *   baseAmount = transactionAmount / rate
 *
 * For IDENTITY (USD in a USD-base company):
 *   baseAmount = transactionAmount
 *
 * Never silently falls back to 1 for a non-base currency without a rate.
 */
export function convertTransactionToBase(
  transactionAmount: string | number,
  transactionCurrency: string,
  baseCurrency: string,
  historicalRate: string | number | null | undefined,
  convention: RateConventionValue
): string {
  const txNorm = normalizeCurrencyCode(transactionCurrency);
  const baseNorm = normalizeCurrencyCode(baseCurrency);
  const amount = new Decimal(transactionAmount);
  if (!amount.isFinite()) throw new Error("transactionAmount must be finite");

  if (txNorm === baseNorm) {
    return amount.toDecimalPlaces(6).toFixed(6);
  }
  if (convention === RateConvention.IDENTITY) {
    throw new InvalidExchangeRateError(
      `IDENTITY is invalid for ${txNorm}->${baseNorm}; an explicit foreign-currency rate is required.`
    );
  }

  if (convention === RateConvention.TRANSACTION_PER_BASE) {
    // baseAmount = transactionAmount / rate  (e.g. CFA / cfaPerUsd = USD)
    const rate = validateHistoricalRate(historicalRate, `convertTransactionToBase rate for ${txNorm}→${baseNorm}`);
    return amount.div(rate).toDecimalPlaces(6).toFixed(6);
  }

  if (convention === RateConvention.BASE_PER_TRANSACTION) {
    // baseAmount = transactionAmount * rate  (e.g. EUR * usdPerEur = USD)
    const rate = validateHistoricalRate(historicalRate, `convertTransactionToBase rate for ${txNorm}→${baseNorm}`);
    return amount.times(rate).toDecimalPlaces(6).toFixed(6);
  }

  throw new Error(`Unknown rate convention: "${convention}"`);
}

/**
 * Convert a base-currency (USD) amount to transaction currency.
 *
 * For TRANSACTION_PER_BASE (CFA per USD):
 *   transactionAmount = baseAmount * rate
 */
export function convertBaseToTransaction(
  baseAmount: string | number,
  transactionCurrency: string,
  baseCurrency: string,
  historicalRate: string | number | null | undefined,
  convention: RateConventionValue
): string {
  const txNorm = normalizeCurrencyCode(transactionCurrency);
  const baseNorm = normalizeCurrencyCode(baseCurrency);
  const amount = new Decimal(baseAmount);
  if (!amount.isFinite()) throw new Error("baseAmount must be finite");

  if (txNorm === baseNorm) {
    return amount.toDecimalPlaces(6).toFixed(6);
  }
  if (convention === RateConvention.IDENTITY) {
    throw new InvalidExchangeRateError(
      `IDENTITY is invalid for ${baseNorm}->${txNorm}; an explicit foreign-currency rate is required.`
    );
  }

  if (convention === RateConvention.TRANSACTION_PER_BASE) {
    const rate = validateHistoricalRate(historicalRate, `convertBaseToTransaction rate for ${baseNorm}→${txNorm}`);
    return amount.times(rate).toDecimalPlaces(6).toFixed(6);
  }

  if (convention === RateConvention.BASE_PER_TRANSACTION) {
    const rate = validateHistoricalRate(historicalRate, `convertBaseToTransaction rate for ${baseNorm}→${txNorm}`);
    return amount.div(rate).toDecimalPlaces(6).toFixed(6);
  }

  throw new Error(`Unknown rate convention: "${convention}"`);
}

export interface NormalizeVoucherEntryAmountsInput {
  /** Transaction currency code, e.g. "ZMW", "USD" or legacy "CFA". ISO "XOF" is normalised to "CFA". */
  transactionCurrency: string;
  /** Base/functional currency of the company (typically "USD"). */
  baseCurrency: string;
  /**
   * Transaction-currency debit amount as typed/submitted.
   * Pass "0" (not null) when this entry has no debit side.
   */
  transactionDebitAmount: string | number;
  /**
   * Transaction-currency credit amount as typed/submitted.
   * Pass "0" (not null) when this entry has no credit side.
   */
  transactionCreditAmount: string | number;
  /**
   * The historical exchange rate at posting time.
   * For TRANSACTION_PER_BASE: foreign units per USD, locked on the voucher.
   * Required for any non-IDENTITY entry; must be a valid positive number.
   * NEVER pass null for a non-base currency — the function will throw.
   */
  historicalRate: string | number | null | undefined;
}

/**
 * Core normalization function.
 *
 * Validates inputs and returns a branded NormalizedEntryAmounts object
 * that carries all dual-currency fields ready to be persisted.
 *
 * Rules:
 *  - An entry must have exactly one of debit or credit > 0 (not both, not neither).
 *  - For USD in a USD-base company: convention = IDENTITY, rate = 1.
 *  - For CFA or ZMW using foreign units per USD: convention = TRANSACTION_PER_BASE,
 *    baseDebit = txDebit / rate, backward-compat debitAmount = baseDebit.
 *  - debitAmount (backward compat) always equals baseDebitAmount.
 */
export function normalizeVoucherEntryAmounts(input: NormalizeVoucherEntryAmountsInput): NormalizedEntryAmounts {
  const { baseCurrency, historicalRate } = input;

  const txCurrency = normalizeCurrencyCode(input.transactionCurrency);
  const baseCcy = normalizeCurrencyCode(baseCurrency);

  const txDebit = new Decimal(input.transactionDebitAmount ?? 0);
  const txCredit = new Decimal(input.transactionCreditAmount ?? 0);

  if (!txDebit.isFinite() || !txCredit.isFinite()) {
    throw new Error("Posted transaction debit and credit amounts must be finite");
  }

  // Validate: amounts must be non-negative
  if (txDebit.lt(0)) throw new Error("transactionDebitAmount must be ≥ 0");
  if (txCredit.lt(0)) throw new Error("transactionCreditAmount must be ≥ 0");

  // Validate: exactly one side must carry value (for posted entries)
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

  // Determine convention
  let convention: RateConventionValue;
  let rateDecimal: Decimal;
  let rateStr: string;

  if (txCurrency === baseCcy) {
    convention = RateConvention.IDENTITY;
    rateDecimal = new Decimal(1);
    rateStr = "1.0000000000";
  } else {
    // Non-base currency REQUIRES a valid positive rate — never silently default to 1
    rateDecimal = validateHistoricalRate(historicalRate, `historical rate for ${txCurrency}/${baseCcy}`);
    rateStr = rateDecimal.toDecimalPlaces(10).toFixed(10);
    // Compute using exactly the rate precision that is persisted on the entry.
    rateDecimal = validateHistoricalRate(rateStr, `stored historical rate for ${txCurrency}/${baseCcy}`);
    // ERP foreign vouchers store transaction units per one base unit.
    convention = RateConvention.TRANSACTION_PER_BASE;
  }

  // Compute base amounts
  let baseDebit: Decimal;
  let baseCredit: Decimal;

  if (convention === RateConvention.IDENTITY) {
    baseDebit = txDebit;
    baseCredit = txCredit;
  } else if (convention === RateConvention.TRANSACTION_PER_BASE) {
    baseDebit = txDebit.div(rateDecimal);
    baseCredit = txCredit.div(rateDecimal);
  } else {
    baseDebit = txDebit.times(rateDecimal);
    baseCredit = txCredit.times(rateDecimal);
  }

  const baseDebitStr = baseDebit.toDecimalPlaces(6).toFixed(6);
  const baseCreditStr = baseCredit.toDecimalPlaces(6).toFixed(6);

  return {
    [_normalizedBrand]: true,
    transactionCurrency: txCurrency,
    transactionDebitAmount: txDebit.toDecimalPlaces(6).toFixed(6),
    transactionCreditAmount: txCredit.toDecimalPlaces(6).toFixed(6),
    baseDebitAmount: baseDebitStr,
    baseCreditAmount: baseCreditStr,
    historicalExchangeRate: rateStr,
    rateConvention: convention,
    // Backward-compatible fields always equal the historical base amounts.
    // Legacy queries that SUM debitAmount - creditAmount over entries get the
    // historical USD value, not a mix of transaction-currency and base-currency rows.
    debitAmount: baseDebitStr,
    creditAmount: baseCreditStr,
  } as NormalizedEntryAmounts;
}

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
