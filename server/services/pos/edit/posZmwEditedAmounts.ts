import { calculateZmwSaleAmounts } from "@shared/posZmwMoney";
import type { PosEditSaleItemInput } from "./posEditSaleTypes";

export function posZmwEditUsdRows(items: PosEditSaleItemInput[]) {
  return items.map((item) => ({ rate: item.sellingPrice, originalCurrencyRate: item.originalCurrencyRate }));
}

export function editedZmwSaleAmounts(
  voucher: { currency?: string | null; exchangeRate?: string | null },
  items: PosEditSaleItemInput[]
): { nativeTotal: string; usdTotal: number } | null {
  if (voucher.currency !== "ZMW") return null;
  return calculateZmwSaleAmounts(
    items.map((item) => ({ ...item, rate: item.sellingPrice })),
    String(voucher.exchangeRate),
    true
  );
}
