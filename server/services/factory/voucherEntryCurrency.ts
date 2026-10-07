/**
 * The native and USD amounts of a voucher entry, for readers that convert
 * entries themselves (2026-10 accounting audit, wave 6).
 *
 * A voucher entry is in one of two shapes:
 *   - normalized: `transaction_currency` and the base columns are set;
 *     `debit_amount`/`credit_amount` hold the USD base (the voucher-entry
 *     trigger does this for USD and CFA, and the factory writers for every
 *     currency);
 *   - legacy: the dual columns are NULL and, on a non-USD voucher,
 *     `debit_amount`/`credit_amount` hold the native amount in the voucher's
 *     currency.
 *
 * The factory supplier readers converted `debit_amount` from the voucher's
 * currency on every row, so a normalized row (already USD) was converted a
 * second time. They now use the stored base for normalized rows and keep their
 * existing conversion for legacy rows only, so no legacy figure changes.
 */
import type Decimal from "decimal.js";

import { voucherEntries, vouchers } from "@shared/schema";

import { toMoney } from "../../lib/money";

export interface VoucherEntryCurrencyRow {
  debitAmount: string | number | null;
  creditAmount: string | number | null;
  /** vouchers.currency */
  currency: string | null;
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | number | null;
  transactionCreditAmount?: string | number | null;
  baseDebitAmount?: string | number | null;
  baseCreditAmount?: string | number | null;
}

/** True when the entry carries its native amount and its USD base. */
export function isNormalizedEntry(row: VoucherEntryCurrencyRow): boolean {
  return (
    row.transactionCurrency != null &&
    row.transactionCurrency !== "" &&
    row.baseDebitAmount != null &&
    row.baseCreditAmount != null
  );
}

/** The entry's amounts in its own currency. */
export function entryNativeAmounts(row: VoucherEntryCurrencyRow): {
  currency: string;
  debit: Decimal;
  credit: Decimal;
} {
  if (isNormalizedEntry(row)) {
    return {
      currency: String(row.transactionCurrency).toUpperCase(),
      debit: toMoney(row.transactionDebitAmount ?? 0),
      credit: toMoney(row.transactionCreditAmount ?? 0),
    };
  }
  return {
    currency: (row.currency || "USD").toUpperCase(),
    debit: toMoney(row.debitAmount ?? 0),
    credit: toMoney(row.creditAmount ?? 0),
  };
}

/**
 * The entry's stored USD base when it has one: every normalized entry, and a
 * legacy entry on a USD voucher. Null for a legacy foreign-currency entry,
 * which the caller converts as it always has.
 */
export function entryStoredUsdAmounts(row: VoucherEntryCurrencyRow): { debit: Decimal; credit: Decimal } | null {
  if (isNormalizedEntry(row)) {
    return { debit: toMoney(row.baseDebitAmount ?? 0), credit: toMoney(row.baseCreditAmount ?? 0) };
  }
  if ((row.currency || "USD").toUpperCase() === "USD") {
    return { debit: toMoney(row.debitAmount ?? 0), credit: toMoney(row.creditAmount ?? 0) };
  }
  return null;
}

/** The columns VoucherEntryCurrencyRow needs, for a Drizzle select over voucher_entries joined to vouchers. */
export const voucherEntryCurrencyColumns = {
  debitAmount: voucherEntries.debitAmount,
  creditAmount: voucherEntries.creditAmount,
  currency: vouchers.currency,
  transactionCurrency: voucherEntries.transactionCurrency,
  transactionDebitAmount: voucherEntries.transactionDebitAmount,
  transactionCreditAmount: voucherEntries.transactionCreditAmount,
  baseDebitAmount: voucherEntries.baseDebitAmount,
  baseCreditAmount: voucherEntries.baseCreditAmount,
};
