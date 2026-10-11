/**
 * Non-USD purchase orders (accounting audit phase 24, M5; owner decision:
 * allowed, native amount and rate stored, lines normalized, one transaction).
 *
 * Before: a PO imported in EUR (or any non-USD currency) was posted as a USD
 * voucher carrying the native amounts, and those native amounts flowed into
 * Purchases, goods in transit and the offload's STOCK-IN as if they were
 * dollars; the PO had no rate, and the voucher and the PO were written in
 * separate transactions.
 *
 * Now the import resolves the PO currency's recorded rate on or before the
 * import date (units per USD, the phase 24 resolver; a rate sent by the client
 * is accepted within 0.5%; none recorded: 409 EXCHANGE_RATE_REQUIRED), and:
 *   - the Purchase voucher (and the parent's intercompany voucher) is in the PO
 *     currency with normalized lines: native amount, rate, USD = native ÷ rate;
 *   - the PO's money columns (items total, charges) and its lines' rate and
 *     line total hold USD — the ledger currency every downstream reader
 *     (goods in transit, offload valuation, STOCK-IN, statements) already
 *     assumes — and the native figures are kept alongside
 *     (purchase_orders.native_currency / exchange_rate / native_items_total /
 *     native_grand_total, po_line_items.native_rate / native_line_total);
 *     purchase_orders.currency is the currency of the money columns (USD);
 *   - the voucher, its lines, the PO and its lines commit in one transaction.
 * A USD PO is unchanged (rate 1, native = USD).
 */
import type Decimal from "decimal.js";

import { MONEY_DECIMAL_PLACES, MoneyDecimal, toMoney, type MoneyInput } from "../../../lib/money";
import { normalizeVoucherEntryAmounts } from "../currencyAmounts";

export interface PoCurrencyContext {
  /** The currency of the imported amounts. */
  currency: string;
  /** Units of `currency` per USD ("1" for USD). */
  unitsPerUsd: string;
}

export function isForeignPo(context: PoCurrencyContext): boolean {
  return context.currency !== "USD";
}

/** A native amount in USD at the PO rate, in cents. */
export function poUsd(native: MoneyInput, context: PoCurrencyContext): Decimal {
  const amount = toMoney(native);
  if (!isForeignPo(context)) return amount.toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
  return amount.div(toMoney(context.unitsPerUsd)).toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP);
}

/** A native unit rate in USD at the PO rate (`places` decimals, the column's scale). */
export function poUsdRate(nativeRate: MoneyInput, context: PoCurrencyContext, places = 2): Decimal {
  const rate = toMoney(nativeRate);
  if (!isForeignPo(context)) return rate.toDecimalPlaces(places, MoneyDecimal.ROUND_HALF_UP);
  return rate.div(toMoney(context.unitsPerUsd)).toDecimalPlaces(places, MoneyDecimal.ROUND_HALF_UP);
}

interface NativeEntry {
  debitAmount?: string | null;
  creditAmount?: string | null;
}

/**
 * Voucher entries written in the PO's native amounts, normalized: native
 * amount, rate (TRANSACTION_PER_BASE), USD base = native ÷ rate. USD entries
 * are returned unchanged (the currency trigger normalizes them).
 */
export function normalizePoEntries<T extends NativeEntry>(entries: readonly T[], context: PoCurrencyContext): T[] {
  if (!isForeignPo(context)) return [...entries];
  return entries.map((entry) => {
    const normalized = normalizeVoucherEntryAmounts({
      transactionCurrency: context.currency,
      baseCurrency: "USD",
      transactionDebitAmount: String(entry.debitAmount ?? "0"),
      transactionCreditAmount: String(entry.creditAmount ?? "0"),
      historicalRate: context.unitsPerUsd,
    });
    return {
      ...entry,
      debitAmount: normalized.baseDebitAmount,
      creditAmount: normalized.baseCreditAmount,
      transactionCurrency: normalized.transactionCurrency,
      transactionDebitAmount: normalized.transactionDebitAmount,
      transactionCreditAmount: normalized.transactionCreditAmount,
      baseDebitAmount: normalized.baseDebitAmount,
      baseCreditAmount: normalized.baseCreditAmount,
      historicalExchangeRate: normalized.historicalExchangeRate,
      rateConvention: normalized.rateConvention,
    };
  });
}

/** The voucher header total (USD) of normalized entries. */
export function poVoucherTotal(entries: readonly NativeEntry[], fallbackNative: Decimal, context: PoCurrencyContext) {
  if (!isForeignPo(context)) return fallbackNative.toFixed(2);
  const total = entries.reduce((sum, entry) => sum.plus(toMoney(entry.debitAmount)), new MoneyDecimal(0));
  return total.toDecimalPlaces(MONEY_DECIMAL_PLACES, MoneyDecimal.ROUND_HALF_UP).toFixed(2);
}

/** The single currency of a PO import's items (blank = USD); null when they mix currencies. */
export function poImportCurrency(items: ReadonlyArray<{ currency?: string | null }>): string | null {
  const currencies = new Set(
    items.map((item) => {
      const code = String(item.currency || "USD")
        .trim()
        .toUpperCase();
      return code === "XOF" ? "CFA" : code || "USD";
    })
  );
  if (currencies.size > 1) return null;
  return [...currencies][0] ?? "USD";
}
