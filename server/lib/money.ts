import Decimal from "decimal.js";

/**
 * Exact money arithmetic for ledger, payroll, report and costing code.
 *
 * Database numeric columns arrive as strings; parseFloat turns them into
 * binary floats, and summing many of those drifts by fractions of a cent
 * (0.1 + 0.2 !== 0.3). Use these helpers instead of parseFloat for money, and
 * convert to a 2-decimal string only at the edge (an insert, a response).
 * tests/float-money-ratchet.test.ts keeps the parseFloat count from growing.
 */
export type MoneyInput = Decimal.Value | null | undefined;

export const MONEY_DECIMAL_PLACES = 2;

/**
 * decimal.js rounds to 20 significant digits by default, and a numeric(20, 2)
 * amount can already use all 20, so sums near that size would round before the
 * final cents conversion. Money arithmetic runs at 40 digits instead; start
 * accumulators with new MoneyDecimal(0) (or toMoney) so operations inherit it.
 */
export const MoneyDecimal = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

/**
 * The Decimal for a value, with its exponent bounded the way a float bounds it,
 * or null for a value a float cannot hold. A Decimal alone has no such bound:
 * "1e1000000000" and "1e-500000000" are both finite, and toFixed() on either
 * writes out hundreds of millions of digits. A value that underflows a float
 * (parseFloat reads it as 0) is exactly 0; one that overflows it is null.
 */
function boundedDecimal(decimal: Decimal): Decimal | null {
  if (!decimal.isFinite()) return null;
  const asFloat = decimal.toNumber();
  if (!Number.isFinite(asFloat)) return null;
  return asFloat === 0 ? new MoneyDecimal(0) : decimal;
}

/**
 * A finite Decimal for any money input; empty, invalid, non-finite or
 * out-of-range input is zero, and a value too small for a float is zero too.
 */
export function toMoney(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return new MoneyDecimal(0);
  try {
    return boundedDecimal(new MoneyDecimal(value)) ?? new MoneyDecimal(0);
  } catch {
    return new MoneyDecimal(0);
  }
}

/**
 * Split `total` across lines in proportion to `weights`, each share in cents,
 * so the shares add up to `total` exactly. Each share is first cut down to the
 * cent, then the cents left over go one at a time to the shares that lost the
 * most in the cut (largest remainder), so no share overshoots and none turns
 * negative. With no positive weight, everything goes to the first line.
 */
export function allocateCents(weights: readonly MoneyInput[], total: MoneyInput): Decimal[] {
  if (weights.length === 0) return [];
  const exactTotal = toMoney(total).toDecimalPlaces(MONEY_DECIMAL_PLACES);
  const parts = weights.map((weight) => MoneyDecimal.max(toMoney(weight), 0));
  const weightSum = sumMoney(parts);
  if (!weightSum.gt(0)) return parts.map((_, index) => (index === 0 ? exactTotal : new MoneyDecimal(0)));

  // Work on the magnitude and restore the sign, so a negative total splits the same way.
  const sign = exactTotal.isNegative() ? -1 : 1;
  const magnitude = exactTotal.abs();
  const exactShares = parts.map((weight) => magnitude.times(weight).dividedBy(weightSum));
  const shares = exactShares.map((share) => share.toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_DOWN));
  const cent = new MoneyDecimal(1).dividedBy(10 ** MONEY_DECIMAL_PLACES);
  let leftoverCents = magnitude.minus(sumMoney(shares)).dividedBy(cent).round().toNumber();
  const byRemainder = exactShares
    .map((share, index) => ({ index, remainder: share.minus(shares[index]) }))
    .sort((a, b) => b.remainder.comparedTo(a.remainder) || a.index - b.index);
  for (const { index } of byRemainder) {
    if (leftoverCents <= 0) break;
    shares[index] = shares[index].plus(cent);
    leftoverCents -= 1;
  }
  return sign < 0 ? shares.map((share) => share.negated()) : shares;
}

/** Quantity x rate as an exact Decimal; round it once where it is stored. */
export function lineAmount(quantity: MoneyInput, rate: MoneyInput): Decimal {
  return toMoney(quantity).times(toMoney(rate));
}

/** Exact sum of money values. */
export function sumMoney(values: Iterable<MoneyInput>): Decimal {
  let total = new MoneyDecimal(0);
  for (const value of values) total = total.plus(toMoney(value));
  return total;
}

/**
 * Adds `value` to a running number total exactly and returns a number, for
 * report totals that are kept as numbers in response objects. Each step goes
 * through the total's shortest decimal form, so cents never drift
 * (0.1 + 0.2 is 0.3, not 0.30000000000000004).
 */
export function plusMoney(total: number, value: MoneyInput): number {
  return toMoney(total).plus(toMoney(value)).toNumber();
}

/** Exact debit minus credit over ledger lines (positive = debit balance). */
export function debitMinusCredit(lines: Iterable<{ debitAmount?: MoneyInput; creditAmount?: MoneyInput }>): Decimal {
  let total = new MoneyDecimal(0);
  for (const line of lines) total = total.plus(toMoney(line.debitAmount)).minus(toMoney(line.creditAmount));
  return total;
}

/** A signed opening balance: Dr positive, Cr negative. */
export function signedOpeningBalance(amount: MoneyInput, side: string | null | undefined): Decimal {
  const value = toMoney(amount);
  return (side || "Dr") === "Cr" ? value.negated() : value;
}

/** Rounded to cents (half up) as the string a numeric(…, 2) column stores. */
export function moneyString(value: MoneyInput): string {
  return toMoney(value).toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP).toFixed(MONEY_DECIMAL_PLACES);
}

/**
 * The amount_usd a daybook entry stores: the caller's own USD amount when it
 * gives one, else amount × rate taken exactly and kept at the column's cents
 * (rounded half away from zero, as Postgres rounds). The float product used to
 * be written whole, so Postgres rounded the float: 1.13 × 1.5 = 1.695 was
 * written as 1.6949999999999998 and stored as 1.69.
 */
export function daybookAmountUsd(
  currency: string,
  amountCurrency: number,
  fxRate: number,
  amountUsd: number | undefined
): string {
  if (amountUsd !== undefined) return String(amountUsd);
  if (currency === "USD") return String(amountCurrency);
  // Non-finite input keeps its old text so a bad amount is not silently zeroed.
  if (!Number.isFinite(amountCurrency) || !Number.isFinite(fxRate)) return String(amountCurrency * fxRate);
  return toMoney(amountCurrency).times(toMoney(fxRate)).toFixed(MONEY_DECIMAL_PLACES);
}

const LEADING_NUMBER = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * Request input as an exact Decimal, read the way parseFloat reads it (the
 * leading number, so "5kg" is 5), or null where parseFloat gives NaN or
 * Infinity, and exactly 0 where parseFloat gives 0. Lets a route keep accepting
 * exactly the input it accepted before while computing with the decimal value
 * instead of a binary float.
 */
export function parseMoneyInput(value: unknown): Decimal | null {
  if (typeof value === "number") return Number.isFinite(value) ? new MoneyDecimal(value) : null;
  if (typeof value !== "string") return null;
  const match = LEADING_NUMBER.exec(value);
  if (!match) return null;
  return boundedDecimal(new MoneyDecimal(match[0].trim()));
}
