import Decimal from "decimal.js";

/**
 * Centralized raw-material currency conversion.
 *
 * `factory_containers.fx_rate_to_usd` (and the analogous fx-rate columns on
 * related tables) default to '1' at the schema level. For a non-USD currency,
 * a stored value of exactly 1 is therefore indistinguishable from "nobody
 * ever explicitly set this" — a genuine 1:1 peg against USD does not occur
 * for this business's supplier currencies (USD/EUR/CDF etc.). This exact
 * "looks set" heuristic already existed ad hoc in rawStockOffloadRoutes.ts;
 * this module makes it the one shared, tested implementation. Every place
 * that derives a USD cost/kg (or any USD amount) from an original-currency
 * value and a stored/fallback exchange rate must go through here instead of
 * inlining a `x || "1"` fallback parse, so a genuinely unresolved rate is never
 * silently treated as 1.
 */

export interface FxRateResolution {
  /** The rate to use for conversion. Only meaningful when looksSet is true. */
  fxRate: number;
  /** False when the currency is non-USD and the rate cannot be trusted as explicitly resolved. */
  looksSet: boolean;
}

/**
 * USD always resolves to 1 with looksSet=true — no rate is ever needed for USD amounts.
 *
 * For non-USD currencies, prefer the explicit `fxRateConfirmed` column when the caller
 * has it available (added to factory_containers, factory_offload_additional_charges,
 * and factory_container_commissions) — this is the source of truth and a confirmed
 * rate of exactly 1 IS valid. `confirmed` is `undefined` for tables that don't carry
 * the column yet (e.g. factory_supplier_payments, factory_raw_stock commission fields,
 * factory_daybook_entries) — for those we fall back to the legacy "rate>0 && rate!==1"
 * heuristic as a stopgap, which is a known imprecision (a genuine confirmed 1.0 rate on
 * those tables would still be flagged unresolved) until they get the same column.
 */
export function resolveStoredFxRate(
  currencyCode: string | null | undefined,
  storedFxRateToUsd: string | number | null | undefined,
  confirmed?: boolean
): FxRateResolution {
  const ccy = currencyCode || "USD";
  if (ccy === "USD") return { fxRate: 1, looksSet: true };
  // decimal.js instead of parseFloat: this rate feeds every downstream cost/kg,
  // stock-value, and supplier-balance USD conversion, so float rounding error here
  // would compound across every row that shares the rate. new Decimal(...) throws
  // on genuinely invalid input rather than silently coercing to NaN/0 like parseFloat.
  let rate: Decimal;
  try {
    rate = new Decimal(storedFxRateToUsd ?? 0);
  } catch {
    rate = new Decimal(0);
  }
  const rateNum = rate.toNumber();
  const looksSet = confirmed !== undefined ? confirmed && rate.gt(0) : rate.gt(0) && !rate.eq(1);
  return { fxRate: looksSet ? rateNum : 0, looksSet };
}

/** Applies an already-resolved rate. Only call after confirming looksSet (or use convertToUsdOrNull/convertToUsdOrThrow). */
export function applyFxRate(amount: number, currencyCode: string | null | undefined, fxRate: number): number {
  if ((currencyCode || "USD") === "USD") return amount;
  return new Decimal(amount).times(new Decimal(fxRate)).toNumber();
}

/**
 * Single-call conversion for read/diagnostic paths: returns null (never a
 * silent 1× conversion) when the currency is non-USD and no explicitly-set
 * rate is available, so callers can surface it as "unresolved" instead of
 * displaying a wrong number with no indication anything is off.
 */
export function convertToUsdOrNull(
  amount: number,
  currencyCode: string | null | undefined,
  storedFxRateToUsd: string | number | null | undefined,
  confirmed?: boolean
): number | null {
  const { fxRate, looksSet } = resolveStoredFxRate(currencyCode, storedFxRateToUsd, confirmed);
  if (!looksSet) return null;
  return applyFxRate(amount, currencyCode, fxRate);
}

export class UnresolvedExchangeRateError extends Error {
  currencyCode: string;
  constructor(currencyCode: string) {
    super(
      `No explicitly-set exchange rate is available for ${currencyCode} — refusing to silently default to 1. Provide fxRateToUsd explicitly.`
    );
    this.name = "UnresolvedExchangeRateError";
    this.currencyCode = currencyCode;
  }
}

/**
 * Returns just the resolved rate (not an amount) for write paths that need
 * to persist a raw `exchangeRate`/`fxRateToUsd` value (e.g. a voucher's
 * `exchangeRate` column derived from an already-stored container/charge/
 * commission row) rather than convert a specific amount. Throws
 * `UnresolvedExchangeRateError` instead of silently falling back to 1 when
 * the currency is non-USD and no explicitly-set rate is available.
 */
export function resolveStoredFxRateOrThrow(
  currencyCode: string | null | undefined,
  storedFxRateToUsd: string | number | null | undefined,
  confirmed?: boolean
): number {
  const { fxRate, looksSet } = resolveStoredFxRate(currencyCode, storedFxRateToUsd, confirmed);
  if (!looksSet) throw new UnresolvedExchangeRateError(currencyCode || "USD");
  return fxRate;
}

/**
 * Throwing version for write paths that must reject the write outright
 * rather than silently persist a mispriced USD value. Callers should catch
 * `UnresolvedExchangeRateError` and return HTTP 400 with its message.
 */
export function convertToUsdOrThrow(
  amount: number,
  currencyCode: string | null | undefined,
  storedFxRateToUsd: string | number | null | undefined,
  confirmed?: boolean
): number {
  const result = convertToUsdOrNull(amount, currencyCode, storedFxRateToUsd, confirmed);
  if (result === null) throw new UnresolvedExchangeRateError(currencyCode || "USD");
  return result;
}
