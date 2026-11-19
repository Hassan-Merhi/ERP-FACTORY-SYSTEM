// Extracted from ./purchaseOrderItemsUpdate.ts: a stage of purchaseOrderItemsUpdate.
import { storage } from "../../storage";
import { HttpError } from "../../lib/httpHandlers";
import { isUnsupportedNativeZmwPurchase } from "../../services/accounting/zambiaPurchaseCurrencyGuard";
import { valueZmwPurchaseAtLockedRate } from "../../services/accounting/zambiaPurchaseCosting";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { amountInput, cents } from "./purchaseOrderItemsUpdateHelpers";
import type { Request } from "express";
import type { PurchaseOrderItemInput, PurchaseOrderItemsUpdateContext } from "./purchaseOrderItemsUpdate";

export async function purchaseOrderItemsUpdateStep({
  ctx,
  req,
}: {
  ctx: PurchaseOrderItemsUpdateContext;
  req: Request;
}) {
  const { id, existingPO } = ctx;
  const nativeZmw = isUnsupportedNativeZmwPurchase(existingPO.currency);
  if (
    (nativeZmw || isUnsupportedNativeZmwPurchase(req.body.currency)) &&
    String(req.body.currency ?? existingPO.currency).toUpperCase() !== String(existingPO.currency).toUpperCase()
  ) {
    throw new HttpError(409, "PO currency is locked after posting. Reverse and rebook instead.");
  }
  if (nativeZmw && (!existingPO.historicalExchangeRate || !existingPO.historicalRateDate)) {
    throw new HttpError(409, "Native Kwacha PO has no recoverable locked rate; reconcile before editing.");
  }

  // Get existing line items to preserve values when only name changes
  const existingLineItems = await storage.getLineItemsByPO(id);
  const existingItemsMap = new Map(existingLineItems.map((item) => [item.id, item]));

  // Calculate new items total, preserving existing quantity/rate if not provided
  let itemsTotal = new MoneyDecimal(0);
  const newItems = (req.body.items as PurchaseOrderItemInput[]).map((item) => {
    // Find existing item by id to preserve values
    // Convert item.id to number for consistent Map lookup (request may send string or number)
    const itemIdNum = item.id ? Number(item.id) : null;
    const existingItem = itemIdNum ? existingItemsMap.get(itemIdNum) : null;

    // Use provided values, or fall back to existing values, or default to "0"
    // Also handle empty string as missing value
    const quantity =
      item.quantity !== undefined && item.quantity !== null && item.quantity !== ""
        ? item.quantity.toString()
        : (existingItem?.quantity ?? "0");
    const rate =
      item.rate !== undefined && item.rate !== null && item.rate !== ""
        ? item.rate.toString()
        : nativeZmw
          ? (existingItem?.nativeRate ?? "")
          : (existingItem?.rate ?? "0");
    if (nativeZmw && !rate) throw new HttpError(409, "Missing original native PO line price");
    const lineTotal = amountInput(quantity).times(amountInput(rate));
    itemsTotal = itemsTotal.plus(lineTotal);

    return {
      poId: id,
      stockItemId: (item.stockItemId ?? existingItem?.stockItemId) as number,
      itemName: (item.itemName ?? existingItem?.itemName) as string,
      quantity,
      rate,
      lineTotal: cents(lineTotal),
    };
  });

  // Native ZMW is revalued at the ORIGINAL purchase rate, never a current rate.
  const nativeCost = nativeZmw
    ? valueZmwPurchaseAtLockedRate({
        date: existingPO.historicalRateDate!,
        historicalRate: String(existingPO.historicalExchangeRate),
        lines: newItems.map((item) => ({ quantity: item.quantity, rate: item.rate })),
        charges: {
          freight: req.body.freight ?? existingPO.nativeFreight,
          surcharge: req.body.surcharge ?? existingPO.nativeSurcharge,
          fumigation: req.body.fumigation ?? existingPO.nativeFumigation,
          documentCharges: req.body.documentCharges ?? existingPO.nativeDocumentCharges,
          discount: req.body.discount ?? existingPO.nativeDiscount,
          otherCharges: req.body.otherCharges ?? existingPO.nativeOtherCharges,
        },
      })
    : null;
  const valuedItems = nativeCost
    ? newItems.map((item, index) => ({
        ...item,
        rate: nativeCost.lines[index].rate,
        lineTotal: nativeCost.lines[index].lineTotal,
        nativeRate: nativeCost.lines[index].nativeRate,
        nativeLineTotal: nativeCost.lines[index].nativeLineTotal,
      }))
    : newItems;
  if (nativeCost) itemsTotal = new MoneyDecimal(nativeCost.itemsTotal);

  // Use ?? to correctly handle explicit zero values from the request
  const freight = amountInput(nativeCost?.freight ?? req.body.freight ?? existingPO.freight ?? "0");
  const surcharge = amountInput(nativeCost?.surcharge ?? req.body.surcharge ?? existingPO.surcharge ?? "0");
  const fumigation = amountInput(nativeCost?.fumigation ?? req.body.fumigation ?? existingPO.fumigation ?? "0");
  const documentCharges = amountInput(
    nativeCost?.documentCharges ?? req.body.documentCharges ?? existingPO.documentCharges ?? "0"
  );
  const discount = amountInput(nativeCost?.discount ?? req.body.discount ?? existingPO.discount ?? "0");
  const otherCharges = amountInput(nativeCost?.otherCharges ?? req.body.otherCharges ?? existingPO.otherCharges ?? "0");
  // Every charge but the freight, net of the discount.
  const nonFreightCharges = sumMoney([surcharge, fumigation, documentCharges, otherCharges]).minus(discount);

  return {
    id,
    existingPO,
    nativeZmw,
    existingLineItems,
    itemsTotal,
    nativeCost,
    valuedItems,
    freight,
    surcharge,
    fumigation,
    documentCharges,
    discount,
    otherCharges,
    nonFreightCharges,
  };
}
