import { posNativeSaleAmounts } from "../posZmwRatePolicy";
import type { PosEditSaleItemInput } from "./posEditSaleTypes";

export function posZmwEditUsdRows(items: PosEditSaleItemInput[]) {
  return items.map((item) => ({ rate: item.sellingPrice, originalCurrencyRate: item.originalCurrencyRate }));
}

/**
 * Exact local-currency total of an edited sale at the voucher's LOCKED rate.
 * Kwacha lines without a typed price are reconstructed; a CFA sale is exact
 * only when every line carries its typed CFA price (see posNativeSaleAmounts).
 */
export function editedZmwSaleAmounts(
  voucher: { currency?: string | null; exchangeRate?: string | null },
  items: PosEditSaleItemInput[],
  keepUsdPosting = false
): { nativeTotal: string; usdTotal: number } | null {
  if (voucher.currency !== "ZMW" && voucher.currency !== "CFA") return null;
  return posNativeSaleAmounts(
    items.map((item) => ({ ...item, rate: item.sellingPrice })),
    { currency: voucher.currency, exchangeRate: voucher.exchangeRate ? String(voucher.exchangeRate) : null },
    keepUsdPosting,
    true
  );
}
