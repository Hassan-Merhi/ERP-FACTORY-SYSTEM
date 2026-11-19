// Extracted from ./purchaseOrderItemsUpdate.ts: a stage of purchaseOrderItemsUpdate.
import { eq, and } from "drizzle-orm";
import { containers, containerOffloads, purchaseOrders, poLineItems, vouchers } from "@shared/schema";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import {
  assertOffloadedPurchaseOrderChargesUnchanged,
  assertOffloadedPurchaseOrderCostBasisUnchanged,
} from "./offloadedPurchaseOrderCostBasisGuard";
import { cents } from "./purchaseOrderItemsUpdateHelpers";
import type { Request } from "express";
import type { purchaseOrderItemsUpdateStep } from "./purchaseOrderItemsUpdateStep";
import type { PurchaseOrderItemInput } from "./purchaseOrderItemsUpdate";
import type { DbTransaction } from "../../db";

type PurchaseOrderItemsUpdateStepResult = Awaited<ReturnType<typeof purchaseOrderItemsUpdateStep>>;

export async function purchaseOrderItemsUpdateStep2({
  poi1,
  tx,
  req,
}: {
  poi1: PurchaseOrderItemsUpdateStepResult;
  tx: DbTransaction;
  req: Request;
}) {
  const {
    existingPO,
    id,
    nativeZmw,
    itemsTotal,
    freight,
    surcharge,
    fumigation,
    documentCharges,
    discount,
    otherCharges,
    valuedItems,
    nativeCost,
    nonFreightCharges,
  } = poi1;
  // FOR UPDATE is the serialization boundary shared with executeContainerOffloadLifecycle.
  // A purchase order without a container has no offload to race with, so only
  // the PO row is locked for it.
  let lockedContainer: { id: number; status: string | null } | undefined;
  if (existingPO.containerId != null) {
    [lockedContainer] = await tx
      .select({ id: containers.id, status: containers.status })
      .from(containers)
      .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
      .limit(1)
      .for("update");

    if (!lockedContainer) {
      throw new HttpError(404, "Container not found for this purchase order");
    }
  }

  // Take the PO row second, matching the offload lifecycle's container -> PO lock
  // order and making every item rewrite for this PO serialize behind the same row.
  const [lockedPO] = await tx
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.id, id), eq(purchaseOrders.companyId, existingPO.companyId)))
    .limit(1)
    .for("update");

  if (!lockedPO || lockedPO.containerId !== existingPO.containerId) {
    throw new HttpError(409, "Purchase order changed concurrently. Reload and try again.");
  }

  // The route performs a fast user-facing check before entering the transaction.
  // Re-check here after the container lock so an offload that won the race cannot
  // be followed by a stock-item swap against inventory that was already materialized.
  const hasActiveOffload = lockedContainer
    ? (
        await tx
          .select({ id: containerOffloads.id })
          .from(containerOffloads)
          .where(and(eq(containerOffloads.containerId, lockedContainer.id), eq(containerOffloads.optional, false)))
          .limit(1)
      ).length > 0
    : false;
  // The materialized receipt remains posted even after status advances beyond OFFLOADED.
  const receiptPosted = lockedContainer?.status === "OFFLOADED" || hasActiveOffload;
  if (nativeZmw && receiptPosted) {
    throw new HttpError(409, "Reverse the offload before editing native Kwacha purchase quantities or prices.");
  }
  if (receiptPosted) {
    if (String(req.body.currency ?? lockedPO.currency).toUpperCase() !== String(lockedPO.currency).toUpperCase()) {
      throw new HttpError(409, "Cannot change purchase currency after stock has been received.");
    }
    if (!toMoney(lockedPO.itemsTotal).toDecimalPlaces(2).equals(itemsTotal.toDecimalPlaces(2))) {
      throw new HttpError(409, "Cannot change an offloaded purchase order item total without reversing the receipt.");
    }
    assertOffloadedPurchaseOrderChargesUnchanged(lockedPO, {
      freight: freight.toFixed(2),
      surcharge: surcharge.toFixed(2),
      fumigation: fumigation.toFixed(2),
      documentCharges: documentCharges.toFixed(2),
      discount: discount.toFixed(2),
      otherCharges: otherCharges.toFixed(2),
    });
    const currentLineItems = await tx
      .select({
        id: poLineItems.id,
        stockItemId: poLineItems.stockItemId,
        itemName: poLineItems.itemName,
        quantity: poLineItems.quantity,
        rate: poLineItems.rate,
        lineTotal: poLineItems.lineTotal,
      })
      .from(poLineItems)
      .where(eq(poLineItems.poId, id));

    assertOffloadedPurchaseOrderCostBasisUnchanged(currentLineItems, valuedItems);

    // The posted rows are historical evidence. Preserve their IDs and only
    // allow a label edit when the caller supplies the original line ID.
    const byId = new Map(currentLineItems.map((item) => [item.id, item]));
    for (const item of req.body.items as PurchaseOrderItemInput[]) {
      const stored = byId.get(Number(item.id));
      if (!stored) {
        if (item.itemName != null) {
          const matchesExistingLabel = currentLineItems.some((line) => line.itemName === item.itemName);
          if (!matchesExistingLabel) {
            throw new HttpError(409, "Name changes on an offloaded purchase line require its original line ID.");
          }
        }
        continue;
      }
      if (item.itemName != null && item.itemName !== stored.itemName) {
        await tx.update(poLineItems).set({ itemName: item.itemName }).where(eq(poLineItems.id, stored.id));
      }
    }
  } else {
    // Unposted items are safe to replace. Posted item identities are never rebuilt.
    await tx.delete(poLineItems).where(eq(poLineItems.poId, id));
    if (valuedItems.length > 0) {
      await tx.insert(poLineItems).values(valuedItems);
    }
  }

  // Update PO with new items total and charges
  // Check if any charge field was explicitly provided in the request
  const chargesWereEdited =
    req.body.freight !== undefined ||
    req.body.surcharge !== undefined ||
    req.body.fumigation !== undefined ||
    req.body.documentCharges !== undefined ||
    req.body.discount !== undefined ||
    req.body.otherCharges !== undefined;

  await tx
    .update(purchaseOrders)
    .set({
      itemsTotal: cents(itemsTotal),
      ...(nativeCost
        ? {
            nativeLineCount: nativeCost.nativeLineCount,
            nativeItemsTotal: nativeCost.nativeItemsTotal,
            nativeFreight: nativeCost.nativeFreight,
            nativeSurcharge: nativeCost.nativeSurcharge,
            nativeFumigation: nativeCost.nativeFumigation,
            nativeDocumentCharges: nativeCost.nativeDocumentCharges,
            nativeDiscount: nativeCost.nativeDiscount,
            nativeOtherCharges: nativeCost.nativeOtherCharges,
          }
        : {}),
      freight: cents(freight),
      surcharge: cents(surcharge),
      fumigation: cents(fumigation),
      documentCharges: cents(documentCharges),
      discount: cents(discount),
      otherCharges: cents(otherCharges),
      chargesEdited: chargesWereEdited ? true : existingPO.chargesEdited,
      poNumber: req.body.poNumber || existingPO.poNumber,
      currency: req.body.currency || existingPO.currency,
      status: req.body.status || existingPO.status,
      ...(req.body.freightPaidBy !== undefined ? { freightPaidBy: req.body.freightPaidBy } : {}),
      ...(req.body.freightOwnAccountId !== undefined
        ? {
            freightOwnAccountId: req.body.freightOwnAccountId === null ? null : Number(req.body.freightOwnAccountId),
          }
        : {}),
      ...(req.body.freightParentAccountId !== undefined
        ? {
            freightParentAccountId:
              req.body.freightParentAccountId === null ? null : Number(req.body.freightParentAccountId),
          }
        : {}),
    })
    .where(eq(purchaseOrders.id, id));

  // Also update container's totals if applicable
  if (lockedContainer) {
    // Get all POs for this container and recalculate totals
    const containerPOs = await tx
      .select()
      .from(purchaseOrders)
      .where(
        and(eq(purchaseOrders.companyId, existingPO.companyId), eq(purchaseOrders.containerId, existingPO.containerId))
      );
    let totalItemsCost = new MoneyDecimal(0);
    let totalCharges = new MoneyDecimal(0);

    for (const po of containerPOs) {
      if (po.id === id) {
        // Use the new values for this PO
        totalItemsCost = totalItemsCost.plus(itemsTotal);
        totalCharges = totalCharges.plus(freight).plus(nonFreightCharges);
      } else {
        totalItemsCost = totalItemsCost.plus(toMoney(po.itemsTotal));
        totalCharges = totalCharges
          .plus(sumMoney([po.freight, po.surcharge, po.fumigation, po.documentCharges, po.otherCharges]))
          .minus(toMoney(po.discount));
      }
    }

    // Update container totals
    const chargesTotal = totalCharges;
    await tx
      .update(containers)
      .set({
        itemsTotal: cents(totalItemsCost),
        chargesTotal: cents(chargesTotal),
        grandTotal: cents(totalItemsCost.plus(chargesTotal)),
      })
      .where(eq(containers.id, existingPO.containerId));
  }

  // Compute totals. intercoTotal = supplier share (excludes freight when own/parent-paid).
  const poGrandTotalExact = itemsTotal.plus(freight).plus(nonFreightCharges);
  const b1FreightPaidBy: string = req.body.freightPaidBy ?? existingPO.freightPaidBy ?? "supplier";
  // 'own': freight goes to a separate own-account voucher → exclude from PO voucher
  // 'parent': subsidiary still owes parent the full amount including freight → use poGrandTotalExact
  // 'supplier': full amount
  const b1IntercoTotal = cents(
    b1FreightPaidBy === "own" && freight.greaterThan(0) ? itemsTotal.plus(nonFreightCharges) : poGrandTotalExact
  );

  // A reversed offload may have retired the purchase voucher while keeping its
  // historical PO link. Never modify or resurrect that deleted accounting row.
  const [linkedVoucher] = existingPO.voucherId
    ? await tx
        .select({
          deletedAt: vouchers.deletedAt,
          voucherDate: vouchers.voucherDate,
          totalAmount: vouchers.totalAmount,
        })
        .from(vouchers)
        .where(and(eq(vouchers.id, existingPO.voucherId), eq(vouchers.companyId, existingPO.companyId)))
        .limit(1)
    : [];
  const hasRetiredPurchaseVoucher = !!existingPO.voucherId && (!linkedVoucher || !!linkedVoucher.deletedAt);

  return {
    chargesWereEdited,
    poGrandTotalExact,
    b1FreightPaidBy,
    b1IntercoTotal,
    linkedVoucher,
    hasRetiredPurchaseVoucher,
  };
}
