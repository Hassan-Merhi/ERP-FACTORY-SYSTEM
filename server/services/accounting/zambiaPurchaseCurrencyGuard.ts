/**
 * Phase 8 purchase/stock currency boundary.
 *
 * PO line prices, container landed values and GIT/STOCK-IN journals currently
 * store historical USD cents. Merely setting purchase_orders.currency=ZMW does
 * not convert those amounts and could corrupt inventory and a parent voucher.
 * Fail closed rather than silently invent a 1:1 conversion.
 *
 * Native Kwacha PO paths must retain every original native
 * price/charge, the approved dated USD/ZMW rate and the converted USD cost
 * before they can enter a purchase storage/write path.
 */
import { HttpError } from "../../lib/httpError";

export const ZMW_PURCHASE_REQUIRES_HISTORICAL_COST =
  "This legacy purchase-voucher endpoint cannot safely edit original Kwacha prices. Use the purchase-order editor or ZMW purchase importer, which preserve approved historical FX and locked USD stock costs.";

export function isUnsupportedNativeZmwPurchase(currency: unknown): boolean {
  return typeof currency === "string" && currency.trim().toUpperCase() === "ZMW";
}

export function assertHistoricalUsdPurchaseCost(currency: unknown): void {
  if (isUnsupportedNativeZmwPurchase(currency)) {
    throw new HttpError(409, ZMW_PURCHASE_REQUIRES_HISTORICAL_COST);
  }
}
