/**
 * Shared currency metadata for ERP and Factory presentation/domain boundaries.
 *
 * Amounts here are only formatted or currency codes validated. No exchange-rate
 * lookup, rounding of posted amounts, or implicit USD conversion takes place.
 *
 * Historical compatibility: this ERP stores West African XOF as its legacy
 * "CFA" identifier. This alias does NOT apply to XAF (a different CFA franc).
 */
export const ACCOUNTING_CURRENCY_CODES = [
  "USD",
  "CFA",
  "XOF",
  "XAF",
  "EUR",
  "AUD",
  "GBP",
  "CNY",
  "NGN",
  "GHS",
  "CDF",
  "JPY",
  "CAD",
  "CHF",
  "ZMW",
] as const;

export type SupportedAccountingCurrency = (typeof ACCOUNTING_CURRENCY_CODES)[number];

const knownCurrencyCodes: ReadonlySet<string> = new Set(ACCOUNTING_CURRENCY_CODES);

/** Check support without silently changing or replacing an unknown code. */
export function isSupportedAccountingCurrency(code: string): code is SupportedAccountingCurrency {
  return knownCurrencyCodes.has(code);
}

/** Preserve the ERP's existing XOF -> CFA storage alias; keep ZMW unchanged. */
export function normalizeAccountingCurrencyAlias(code: string): string {
  const upper = code.trim().toUpperCase();
  return upper === "XOF" ? "CFA" : upper;
}

export interface CurrencyDisplayMetadata {
  readonly prefix: string;
  readonly fractionDigits: number;
}

/**
 * Explicit currency label and default *display* precision.
 *
 * The fallback intentionally labels an unregistered currency with its code;
 * it is never interpreted as USD and cannot authorize accounting postings.
 */
const DISPLAY_METADATA: Readonly<Record<string, CurrencyDisplayMetadata>> = {
  USD: { prefix: "$", fractionDigits: 2 },
  EUR: { prefix: "€", fractionDigits: 2 },
  GBP: { prefix: "£", fractionDigits: 2 },
  CFA: { prefix: "CFA ", fractionDigits: 0 },
  XAF: { prefix: "CFA ", fractionDigits: 0 },
  XOF: { prefix: "CFA ", fractionDigits: 0 },
  CDF: { prefix: "CDF ", fractionDigits: 2 },
  ZMW: { prefix: "K", fractionDigits: 2 },
};

export function getCurrencyDisplayMetadata(currency: string): CurrencyDisplayMetadata {
  const code = currency.trim().toUpperCase();
  return DISPLAY_METADATA[code] ?? { prefix: code ? `${code} ` : "", fractionDigits: 2 };
}
