/**
 * Retail journals in a company whose currency is not USD (accounting audit
 * phase 24, M11; owner decision: at the dated rate).
 *
 * Before: the Retail sale, refund, cash and stock journals posted their
 * amounts (in the company's base currency) on a voucher in that currency with
 * no rate and no native amounts, so the currency trigger refused them in any
 * non-USD company (CFA without a header rate, any other currency without its
 * native amounts).
 *
 * Now a non-USD Retail journal posts normalized lines: the Retail amount is
 * the native amount, the rate is the company's recorded rate dated on or before
 * the voucher date (units per USD, the phase 24 resolver; 409
 * EXCHANGE_RATE_REQUIRED when none — never 1), and the ledger (USD) amount is
 * native ÷ rate; the engine's ROUNDING line absorbs any per-line cent. A USD
 * company is unchanged.
 */
import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import type { VoucherEntryInsertFields } from "../accountingTypes";
import { normalizeVoucherEntryAmounts } from "../currencyAmounts";
import { checkedDocumentRate } from "./clientRateCheck";
import { normalizeRateCurrency } from "./rateResolver";

export interface RetailVoucherCurrency {
  currency: string;
  /** Units of `currency` per USD; null for USD. */
  rate: string | null;
}

/** The currency and dated rate of a Retail journal of the company (throws 409 without a recorded rate). */
export async function retailVoucherCurrencyTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  baseCurrency: string | null | undefined,
  voucherDate: string
): Promise<RetailVoucherCurrency> {
  const currency = normalizeRateCurrency(
    String(baseCurrency || "USD")
      .slice(0, 3)
      .toUpperCase()
  );
  if (currency === "USD") return { currency, rate: null };
  const dated = await checkedDocumentRate(executor, { companyId, currency, documentDate: voucherDate });
  return { currency, rate: dated.rate };
}

/**
 * The entries of a Retail journal in the voucher's currency: unchanged for USD;
 * for another currency each line's amount becomes its native amount, with the
 * USD ledger amount at the dated rate. `totalAmount` is the USD debit total.
 */
export function retailEntriesInCurrency<T extends VoucherEntryInsertFields>(
  entries: readonly T[],
  voucherCurrency: RetailVoucherCurrency,
  nativeTotal: string
): { entries: T[]; totalAmount: string } {
  if (voucherCurrency.currency === "USD" || !voucherCurrency.rate) {
    return { entries: [...entries], totalAmount: nativeTotal };
  }
  let total = new MoneyDecimal(0);
  const normalized = entries.map((entry) => {
    const normalizedAmounts = normalizeVoucherEntryAmounts({
      transactionCurrency: voucherCurrency.currency,
      baseCurrency: "USD",
      transactionDebitAmount: String(entry.debitAmount ?? "0"),
      transactionCreditAmount: String(entry.creditAmount ?? "0"),
      historicalRate: voucherCurrency.rate,
    });
    total = total.plus(toMoney(normalizedAmounts.baseDebitAmount));
    return {
      ...entry,
      debitAmount: normalizedAmounts.baseDebitAmount,
      creditAmount: normalizedAmounts.baseCreditAmount,
      transactionCurrency: normalizedAmounts.transactionCurrency,
      transactionDebitAmount: normalizedAmounts.transactionDebitAmount,
      transactionCreditAmount: normalizedAmounts.transactionCreditAmount,
      baseDebitAmount: normalizedAmounts.baseDebitAmount,
      baseCreditAmount: normalizedAmounts.baseCreditAmount,
      historicalExchangeRate: normalizedAmounts.historicalExchangeRate,
      rateConvention: normalizedAmounts.rateConvention,
    };
  });
  return { entries: normalized, totalAmount: total.toDecimalPlaces(2, MoneyDecimal.ROUND_HALF_UP).toFixed(2) };
}
