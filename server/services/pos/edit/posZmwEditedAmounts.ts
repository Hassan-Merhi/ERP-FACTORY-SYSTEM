import { calculateZmwSaleAmounts } from "@shared/posZmwMoney";
import type { PosEditSaleItemInput } from "./posEditSaleTypes";

export function editedZmwSaleAmounts(
  currency: string | null | undefined,
  exchangeRate: string | null | undefined,
  items: PosEditSaleItemInput[]
): { nativeTotal: string; usdTotal: number } | null {
  if (currency !== "ZMW") return null;
  return calculateZmwSaleAmounts(
    items.map((item) => ({ ...item, rate: item.sellingPrice })),
    String(exchangeRate),
    true
  );
}
