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

/** A finite Decimal for any money input; empty, invalid or non-finite input is zero. */
export function toMoney(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal : new Decimal(0);
  } catch {
    return new Decimal(0);
  }
}

/** Exact sum of money values. */
export function sumMoney(values: Iterable<MoneyInput>): Decimal {
  let total = new Decimal(0);
  for (const value of values) total = total.plus(toMoney(value));
  return total;
}

/** Exact debit minus credit over ledger lines (positive = debit balance). */
export function debitMinusCredit(lines: Iterable<{ debitAmount?: MoneyInput; creditAmount?: MoneyInput }>): Decimal {
  let total = new Decimal(0);
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
  return toMoney(value).toDecimalPlaces(MONEY_DECIMAL_PLACES, Decimal.ROUND_HALF_UP).toFixed(MONEY_DECIMAL_PLACES);
}
