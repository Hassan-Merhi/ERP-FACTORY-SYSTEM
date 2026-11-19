import { calculateZmwSaleAmounts, resolvePostedZmwUnitPrices } from "@shared/posZmwMoney";
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

/** Original Kwacha unit prices for new sales, or reconstruction checked against the posted total. */
export function getPosInvoiceNativeZmwUnits(
  items: InvoiceSaleItem[] | undefined,
  persistedNativeTotal: string | undefined,
  rate: number,
  isZmw: boolean
) {
  if (!isZmw || !items?.length) return [];
  const lines = items.map((item) => ({
    quantity: item.quantity ?? 0,
    originalCurrencyRate: item.originalCurrencyRate,
    rate: item.rateUSD ?? item.rate,
  }));
  return resolvePostedZmwUnitPrices(lines, rate, persistedNativeTotal);
}
