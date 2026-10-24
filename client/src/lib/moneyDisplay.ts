/**
 * Explicit-currency display for already denominated amounts.
 *
 * No FX conversions happen here. Historical accounting amounts must never be
 * retranslated using a current exchange rate. Use CurrencyContext for any
 * conversion, and only when the business operation explicitly calls for it.
 */
import { getCurrencyDisplayMetadata } from "@shared/currencyCatalog";

export interface MoneyDisplayOptions {
  currency: string;
  locale?: string;
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
  placeholder?: string;
}

export function formatMoneyDisplay(
  amount: number | string | null | undefined,
  { currency, locale = "en-US", minimumFractionDigits, maximumFractionDigits, placeholder = "—" }: MoneyDisplayOptions
): string {
  if (amount == null || amount === "") return placeholder;
  const numeric = typeof amount === "string" ? Number(amount.trim()) : amount;
  if (!Number.isFinite(numeric)) return placeholder;
  const code = currency.trim().toUpperCase();
  const metadata = getCurrencyDisplayMetadata(code);
  const precision = maximumFractionDigits ?? metadata.fractionDigits;
  const decimals = Math.max(0, Math.min(20, precision));
  // Existing currencies retain their flexible minimum; Kwacha amounts display
  // ngwee explicitly by default (K250.00 rather than K250).
  const defaultMinimum = code === "ZMW" ? 2 : 0;
  const minimum = Math.max(0, Math.min(decimals, minimumFractionDigits ?? defaultMinimum));
  const formatted = numeric.toLocaleString(locale, {
    minimumFractionDigits: minimum,
    maximumFractionDigits: decimals,
  });
  return `${metadata.prefix}${formatted}`;
}

/** Numeric-only formatting, e.g. a summary containing several currencies. */
export function formatMoneyNumber(amount: number | string | null | undefined, decimals = 2, locale = "en-US"): string {
  if (amount == null || amount === "") return "—";
  const numeric = typeof amount === "string" ? Number(amount.trim()) : amount;
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(locale, { maximumFractionDigits: Math.max(0, Math.min(decimals, 20)) })
    : "—";
}
