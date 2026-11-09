/**
 * ERP display-only formatting. Never converts between currencies or modifies
 * persisted amounts, arithmetic, journal postings, or reconciliation precision.
 */
export { useDateFormat as useErpDateFormat } from "@/contexts/DateFormatContext";
export { MoneyAmount as ErpMoneyAmount } from "@/components/MoneyAmount";
export {
  formatMoneyDisplay as formatErpMoneyDisplay,
  formatMoneyNumber as formatErpMoneyNumber,
} from "@/lib/moneyDisplay";
export {
  formatNumber as formatErpNumber,
  formatCurrency as formatErpCurrencyNumber,
  drCrClass as erpDebitCreditClass,
} from "@/lib/formatNumber";

/**
 * Opening and Closing Stock summaries historically show exactly two decimal
 * places, even when the quantity is an integer. Preserve that convention.
 */
export function formatErpFixedQuantity(
  value: number,
  decimals = 2,
): string {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
