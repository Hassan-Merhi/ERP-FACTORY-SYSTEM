import { calculateZmwSaleAmounts, resolveZmwUnitPrice } from "@shared/posZmwMoney";
import type { InvoiceSaleItem } from "./InvoiceTemplate";

/** Reprints use original typed K amounts, or reconstruct at the voucher's saved rate. */
export function getPosInvoiceNativeZmwTotal(
  items: InvoiceSaleItem[] | undefined,
  persistedNativeTotal: string | undefined,
  rate: number,
  isZmw: boolean
): string | undefined {
  if (!isZmw || !items?.length) return persistedNativeTotal;
  if (persistedNativeTotal != null) return persistedNativeTotal;
  const lines = items.map((item) => ({
    quantity: item.quantity ?? 0,
    originalCurrencyRate: item.originalCurrencyRate,
    rate: item.rateUSD ?? item.rate,
  }));
  return calculateZmwSaleAmounts(lines, rate, true).nativeTotal;
}

/** Original Kwacha unit price for new sales, or historical locked-rate reconstruction. */
export function getPosInvoiceNativeZmwUnit(item: InvoiceSaleItem, rate: number) {
  return resolveZmwUnitPrice(
    { quantity: item.quantity ?? 0, originalCurrencyRate: item.originalCurrencyRate, rate: item.rateUSD ?? item.rate },
    rate,
    true
  );
}
