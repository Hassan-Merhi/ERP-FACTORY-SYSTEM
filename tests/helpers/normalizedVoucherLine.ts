import { toMoney } from "../../server/lib/money";

/**
 * The dual-currency fields of a fixture line given its USD base and native
 * amounts, in the one shape the voucher-entry currency normalization trigger
 * (migrations/20260720_005, installed at every boot since wave 14) keeps as
 * given: native, base, rate and convention all set, with the base equal to
 * native × rate rounded to 6 places (BASE_PER_TRANSACTION). The rate is the
 * one that reproduces the base from the native amount.
 *
 * A line that sets transaction_currency without the rate and convention is
 * rewritten by the trigger as a legacy line in the voucher's currency, so a
 * fixture that wants a foreign-currency line on a USD voucher must use this.
 */
export function normalizedLineFields(base: string, native: string, side: "debit" | "credit") {
  const rate = toMoney(base).dividedBy(native).toDecimalPlaces(10);
  const base6 = toMoney(native).times(rate).toDecimalPlaces(6).toFixed(6);
  return {
    transactionDebit: side === "debit" ? native : "0",
    transactionCredit: side === "credit" ? native : "0",
    baseDebit: side === "debit" ? base6 : "0",
    baseCredit: side === "credit" ? base6 : "0",
    rate: rate.toFixed(10),
    convention: "BASE_PER_TRANSACTION" as const,
  };
}
