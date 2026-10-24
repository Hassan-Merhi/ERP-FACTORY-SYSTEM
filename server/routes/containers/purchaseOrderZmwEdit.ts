/**
 * Phase 8: guards for editing a posted native-Kwacha purchase order.
 *
 * A ZMW purchase order keeps its original currency and the approved rate of
 * its own date; charge-only edits are typed in Kwacha and converted once at
 * that locked rate before the existing USD voucher, parent and inventory
 * synchronizers run. USD/CFA purchase orders pass through untouched.
 */
import type { InsertPurchaseOrder, PurchaseOrder } from "@shared/schema";
import { HttpError } from "../../lib/httpHandlers";
import { toMoney } from "../../lib/money";
import { isUnsupportedNativeZmwPurchase } from "../../services/accounting/zambiaPurchaseCurrencyGuard";
import { historicalUsdFromNativeZmw } from "../../services/accounting/zambiaPurchaseCosting";

type EditBody = Record<string, unknown>;

/** Refuses currency or rate changes on a posted Kwacha PO; returns whether it is native ZMW. */
export function assertZmwPurchaseEditAllowed(existingPO: PurchaseOrder, body: EditBody): boolean {
  const nativeZmw = isUnsupportedNativeZmwPurchase(existingPO.currency);
  if (
    (nativeZmw || isUnsupportedNativeZmwPurchase(body.currency)) &&
    String(body.currency ?? existingPO.currency).toUpperCase() !== String(existingPO.currency).toUpperCase()
  ) {
    throw new HttpError(409, "Purchase currency is locked. Reverse and rebook in the new currency.");
  }
  if (nativeZmw && (!existingPO.historicalExchangeRate || !existingPO.historicalRateDate)) {
    throw new HttpError(409, "Original Kwacha purchase FX is unresolved. Reconcile before editing.");
  }
  if (
    nativeZmw &&
    body.exchangeRate != null &&
    !toMoney(String(body.exchangeRate)).eq(toMoney(existingPO.historicalExchangeRate))
  ) {
    throw new HttpError(409, "Historical ZMW purchase rate cannot be edited.");
  }
  return nativeZmw;
}

const CHARGE_KEYS = [
  ["freight", "nativeFreight"],
  ["surcharge", "nativeSurcharge"],
  ["fumigation", "nativeFumigation"],
  ["documentCharges", "nativeDocumentCharges"],
  ["discount", "nativeDiscount"],
  ["otherCharges", "nativeOtherCharges"],
] as const;

/**
 * Charge-only edits arrive in original Kwacha. Keeps them as native evidence
 * and rewrites the request's charge fields to historical USD at the PO's
 * locked rate (mutating `body`, which the existing synchronizers then read).
 */
export function convertNativeChargeEdits(existingPO: PurchaseOrder, body: EditBody): Partial<InsertPurchaseOrder> {
  const nativeChargeChanges: Record<string, string> = {};
  if (body.itemsTotal !== undefined) {
    throw new HttpError(409, "ZMW item totals are derived from native PO lines, not edited separately.");
  }
  for (const [field, nativeField] of CHARGE_KEYS) {
    if (body[field] === undefined) continue;
    nativeChargeChanges[nativeField] = String(body[field]);
    body[field] = historicalUsdFromNativeZmw(
      body[field] as string | number | null | undefined,
      String(existingPO.historicalExchangeRate)
    );
  }
  return nativeChargeChanges as Partial<InsertPurchaseOrder>;
}
