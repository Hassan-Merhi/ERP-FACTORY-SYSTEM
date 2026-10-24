import { getCurrencyDisplayMetadata, type SupportedAccountingCurrency } from "@shared/currencyCatalog";

export type CurrencyCode = SupportedAccountingCurrency;

/**
 * Returns tailwind text-color classes for a Dr/Cr balance side.
 * Dr (Debit)  = green
 * Cr (Credit) = red
 */
export function drCrClass(side: string | null | undefined): string {
  if (!side) return "";
  return side.toUpperCase() === "CR" ? "text-red-500 dark:text-red-400" : "text-green-600 dark:text-green-400";
}

/**
 * Format a number to remove unnecessary .00 decimals and add comma separators
 * @param num - The number to format
 * @param maxDecimals - Maximum decimal places to show (default 2)
 * @returns Formatted string with commas and smart decimals
 */
export function formatNumber(num: number | null | undefined, maxDecimals: number = 2): string {
  if (num == null || !Number.isFinite(num)) return "0";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDecimals,
  });
}

/**
 * Format a currency value (removes .00 for whole numbers, adds commas)
 * @param num - The number to format
 * @returns Formatted string ready for currency display (add $ prefix separately)
 */
export function formatCurrency(num: number | null | undefined): string {
  return formatNumber(num, 2);
}

/**
 * Format a currency value with currency label
 * @param num - The number to format
 * @param currency - The original amount's currency code (e.g. USD, CFA, ZMW)
 * @returns Formatted string with currency symbol/label
 */
export function formatCurrencyWithLabel(num: number | string, currency: CurrencyCode = "USD"): string {
  const numValue = typeof num === "string" ? parseFloat(num) : num;
  if (isNaN(numValue)) return "";

  if (currency === "USD") {
    const isWhole = Math.abs(numValue) % 1 === 0;
    return `$ ${numValue.toLocaleString(undefined, { minimumFractionDigits: isWhole ? 0 : 2, maximumFractionDigits: 2 })}`;
  }
  if (currency === "CFA" || currency === "XOF" || currency === "XAF") {
    return `CFA ${numValue.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
  }

  const meta = getCurrencyDisplayMetadata(currency);
  const minDecimals = currency === "ZMW" ? 2 : Math.abs(numValue) % 1 === 0 ? 0 : meta.fractionDigits;
  const formatted = numValue.toLocaleString(undefined, {
    minimumFractionDigits: minDecimals,
    maximumFractionDigits: meta.fractionDigits,
  });
  return `${meta.prefix}${formatted}`;
}

/**
 * Format a percentage value (removes .00 for whole numbers)
 * @param num - The number to format
 * @returns Formatted string with % suffix
 */
export function formatPercent(num: number): string {
  return `${formatNumber(num, 2)}%`;
}
