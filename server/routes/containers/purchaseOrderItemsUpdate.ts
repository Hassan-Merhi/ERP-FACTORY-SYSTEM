import type { Request } from "express";
import { eq, and } from "drizzle-orm";

import { containers, containerCharges, purchaseOrders, poLineItems, vouchers, voucherEntries } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";
import { logger } from "../../lib/logger";
import { HttpError } from "../../lib/httpHandlers";
import { syncIntercoParentVoucher } from "./containerHelpers";

type PurchaseOrderRecord = NonNullable<Awaited<ReturnType<typeof storage.getPurchaseOrderById>>>;

/**
 * A line item as the client sends it. Every field is optional and loosely typed
 * because the handler falls back to the stored row whenever one is missing or
 * blank, and accepts both string and number for the numeric fields.
 */
interface PurchaseOrderItemInput {
  id?: number | string | null;
  stockItemId?: number | string | null;
  itemName?: string | null;
  quantity?: number | string | null;
  rate?: number | string | null;
}

export interface PurchaseOrderItemsUpdateContext {
  id: number;
  existingPO: PurchaseOrderRecord;
}

/**
 * The line-items path of PATCH /api/purchase-orders/:id.
 *
 * The handler has two disjoint shapes: a request carrying `items` rebuilds the
 * line items and reprices the whole purchase order, and a request without them
 * edits charges only. The first is a complete path that ended in its own
 * `return res.json(...)`, so it moves here whole and returns the response body
 * for the route to send.
 *
 * `req` is passed through rather than destructured because the moved code reads
 * a dozen `req.body` charge fields plus `req.session` for the audit row; keeping
 * it means the arithmetic below is unchanged from what the pin was taken over.
 *
 * config/report-characterization.json pins PATCH /api/purchase-orders/:id
 * across the move.
 */
export async function applyPurchaseOrderItemsUpdate(
  req: Request,
  ctx: PurchaseOrderItemsUpdateContext
): Promise<Record<string, unknown>> {
  const { id, existingPO } = ctx;

  // Get existing line items to preserve values when only name changes
  const existingLineItems = await storage.getLineItemsByPO(id);
  const existingItemsMap = new Map(existingLineItems.map((item) => [item.id, item]));

  // Calculate new items total, preserving existing quantity/rate if not provided
  let itemsTotal = 0;
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
        : (existingItem?.rate ?? "0");
    const lineTotal = parseFloat(quantity) * parseFloat(rate);
    itemsTotal += lineTotal;

    return {
      poId: id,
      stockItemId: (item.stockItemId ?? existingItem?.stockItemId) as number,
      itemName: (item.itemName ?? existingItem?.itemName) as string,
      quantity: quantity,
      rate: rate,
      lineTotal: lineTotal.toFixed(2),
    };
  });

  // Capture freight in outer scope so the post-transaction parent-freight sync
  // can access it without a ReferenceError.
  let _b1FreightForSync = parseFloat(existingPO.freight ?? "0");
  // ── Lifted for post-transaction interco sync (belt-and-suspenders) ────
  let _b1GrandTotalForSync = 0;
  let _b1HasParentFreightForSync = false;
  let _b1FreightParentAccountIdForSync: number | null = null;
  let _b1PoNumsForSync: string | string[] = existingPO.poNumber;
  let _b1ContainerNumForSync: string | undefined;

  // Delete existing line items and create new ones in a transaction.
  // Lock order intentionally matches the offload lifecycle: container -> purchase order.
  // This prevents an offload from materializing inventory between the route pre-check
  // and the line-item rewrite.
  await db.transaction(async (tx) => {
    // FOR UPDATE is the serialization boundary shared with executeContainerOffloadLifecycle.
    const [lockedContainer] = await tx
      .select({ id: containers.id, status: containers.status })
      .from(containers)
      .where(and(eq(containers.id, existingPO.containerId), eq(containers.companyId, existingPO.companyId)))
      .limit(1)
      .for("update");

    if (!lockedContainer) {
      throw new HttpError(404, "Container not found for this purchase order");
    }

    // Take the PO row second, matching the offload lifecycle's container -> PO lock
    // order and making every item rewrite for this PO serialize behind the same row.
    const [lockedPO] = await tx
      .select({ id: purchaseOrders.id, containerId: purchaseOrders.containerId })
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
    if (lockedContainer.status === "OFFLOADED") {
      const currentLineItems = await tx
        .select({ stockItemId: poLineItems.stockItemId })
        .from(poLineItems)
        .where(eq(poLineItems.poId, id));
      const currentStockItemIds = new Set(currentLineItems.map((item) => item.stockItemId));

      for (const item of newItems) {
        if (item.stockItemId && !currentStockItemIds.has(item.stockItemId)) {
          throw new HttpError(
            409,
            "Cannot change stock items on an offloaded container. The inventory has already been added with the original items. Changing stock items would cause an import cycle imbalance. To fix this, first reverse the container offload, then edit the PO, then re-offload."
          );
        }
      }
    }

    // Delete old line items only after the lifecycle locks and offloaded-state recheck.
    await tx.delete(poLineItems).where(eq(poLineItems.poId, id));

    // Insert new line items
    if (newItems.length > 0) {
      await tx.insert(poLineItems).values(newItems);
    }

    // Update PO with new items total and charges
    // Use ?? to correctly handle explicit zero values from the request
    const freight = parseFloat(req.body.freight ?? existingPO.freight ?? "0");
    _b1FreightForSync = freight; // lift into outer scope for post-tx sync
    const surcharge = parseFloat(req.body.surcharge ?? existingPO.surcharge ?? "0");
    const fumigation = parseFloat(req.body.fumigation ?? existingPO.fumigation ?? "0");
    const documentCharges = parseFloat(req.body.documentCharges ?? existingPO.documentCharges ?? "0");
    const discount = parseFloat(req.body.discount ?? existingPO.discount ?? "0");
    const otherCharges = parseFloat(req.body.otherCharges ?? existingPO.otherCharges ?? "0");

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
        itemsTotal: itemsTotal.toFixed(2),
        freight: freight.toFixed(2),
        surcharge: surcharge.toFixed(2),
        fumigation: fumigation.toFixed(2),
        documentCharges: documentCharges.toFixed(2),
        discount: discount.toFixed(2),
        otherCharges: otherCharges.toFixed(2),
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
    const container = await storage.getContainerByIdForCompany(existingPO.containerId, existingPO.companyId);
    if (container) {
      // Get all POs for this container and recalculate totals
      const allPOs = await storage.getAllPurchaseOrders(existingPO.companyId);
      const containerPOs = allPOs.filter((po) => po.containerId === existingPO.containerId);
      let totalItemsCost = 0;
      let totalCharges = 0;

      for (const po of containerPOs) {
        if (po.id === id) {
          // Use the new values for this PO
          totalItemsCost += itemsTotal;
          totalCharges += freight + surcharge + fumigation + documentCharges - discount + otherCharges;
        } else {
          totalItemsCost += parseFloat(po.itemsTotal || "0");
          totalCharges +=
            parseFloat(po.freight || "0") +
            parseFloat(po.surcharge || "0") +
            parseFloat(po.fumigation || "0") +
            parseFloat(po.documentCharges || "0") -
            parseFloat(po.discount || "0") +
            parseFloat(po.otherCharges || "0");
        }
      }

      // Update container totals
      const chargesTotal = totalCharges;
      await tx
        .update(containers)
        .set({
          itemsTotal: totalItemsCost.toFixed(2),
          chargesTotal: chargesTotal.toFixed(2),
          grandTotal: (totalItemsCost + chargesTotal).toFixed(2),
        })
        .where(eq(containers.id, existingPO.containerId));
    }

    // Compute totals. intercoTotal = supplier share (excludes freight when own/parent-paid).
    const poGrandTotal = itemsTotal + freight + surcharge + fumigation + documentCharges - discount + otherCharges;
    const b1FreightPaidBy: string = req.body.freightPaidBy ?? existingPO.freightPaidBy ?? "supplier";
    // 'own': freight goes to a separate own-account voucher → exclude from PO voucher
    // 'parent': subsidiary still owes parent the full amount including freight → use poGrandTotal
    // 'supplier': full amount
    const b1IntercoTotal =
      b1FreightPaidBy === "own" && freight > 0
        ? itemsTotal + surcharge + fumigation + documentCharges - discount + otherCharges
        : poGrandTotal;

    // Update the associated voucher — use supplier share (intercoTotal) so freight excluded
    // when it's paid via own-account or parent-company voucher.
    if (existingPO.voucherId) {
      await tx
        .update(vouchers)
        .set({ totalAmount: b1IntercoTotal.toFixed(2) })
        .where(eq(vouchers.id, existingPO.voucherId));

      const existingEntries = await tx
        .select()
        .from(voucherEntries)
        .where(eq(voucherEntries.voucherId, existingPO.voucherId));

      for (const entry of existingEntries) {
        if (parseFloat(entry.debitAmount || "0") > 0) {
          await tx
            .update(voucherEntries)
            .set({ debitAmount: b1IntercoTotal.toFixed(2), creditAmount: "0" })
            .where(eq(voucherEntries.id, entry.id));
        } else if (parseFloat(entry.creditAmount || "0") > 0) {
          await tx
            .update(voucherEntries)
            .set({ creditAmount: b1IntercoTotal.toFixed(2), debitAmount: "0" })
            .where(eq(voucherEntries.id, entry.id));
        }
      }
    }

    // ── Inter-company sync: only for true subsidiary POs (not same-company).
    // Freight for same-company POs is embedded directly in the PO voucher above.
    {
      const _b1ParentId = await storage.getParentCompanyId();
      if (_b1ParentId && existingPO.companyId !== _b1ParentId) {
        const _b1FreightParentAccountId: number | null =
          req.body.freightParentAccountId !== undefined
            ? req.body.freightParentAccountId === null
              ? null
              : Number(req.body.freightParentAccountId)
            : (existingPO.freightParentAccountId ?? null);
        const _b1HasParentFreight = b1FreightPaidBy === "parent" && freight > 0 && !!_b1FreightParentAccountId;
        const _b1NewPoNum =
          req.body.poNumber && req.body.poNumber !== existingPO.poNumber ? (req.body.poNumber as string) : null;
        const _b1PoNums = _b1NewPoNum ? [existingPO.poNumber, _b1NewPoNum] : existingPO.poNumber;
        const _b1ContainerRow = existingPO.containerId
          ? (
              await tx
                .select({ containerNumber: containers.containerNumber })
                .from(containers)
                .where(eq(containers.id, existingPO.containerId))
                .limit(1)
            )[0]
          : undefined;
        const _b1Sync = await syncIntercoParentVoucher(
          tx,
          _b1PoNums,
          poGrandTotal,
          _b1ContainerRow?.containerNumber,
          _b1HasParentFreight
            ? {
                freightAmount: freight,
                freightParentAccountId: _b1FreightParentAccountId!,
                subsidiaryCompanyId: existingPO.companyId,
              }
            : undefined
        );
        if (!_b1Sync.found) {
          logger.warn(
            `[PO-PATCH items] No INTERCO-PARENT voucher for PO(s): ${Array.isArray(_b1PoNums) ? _b1PoNums.join(", ") : _b1PoNums}`
          );
        }
        // Lift to outer scope so post-transaction backup sync can use them
        _b1GrandTotalForSync = poGrandTotal;
        _b1HasParentFreightForSync = _b1HasParentFreight;
        _b1FreightParentAccountIdForSync = _b1FreightParentAccountId;
        _b1PoNumsForSync = _b1PoNums;
        _b1ContainerNumForSync = _b1ContainerRow?.containerNumber;
      }
    }

    // Sync container_charges table when PO charges are edited
    if (chargesWereEdited && existingPO.containerId) {
      const chargeTypeMap = [
        { field: "freight", chargeType: "Freight", amount: freight },
        { field: "surcharge", chargeType: "Surcharge", amount: surcharge },
        { field: "fumigation", chargeType: "Fumigation", amount: fumigation },
        { field: "documentCharges", chargeType: "Document Charges", amount: documentCharges },
        { field: "discount", chargeType: "Discount", amount: -discount }, // Discount stored as negative
        { field: "otherCharges", chargeType: "Other Charges", amount: otherCharges },
      ];

      for (const { chargeType, amount } of chargeTypeMap) {
        // Find existing container charge entry
        const existingCharge = await tx
          .select()
          .from(containerCharges)
          .where(
            and(eq(containerCharges.containerId, existingPO.containerId), eq(containerCharges.chargeType, chargeType))
          )
          .limit(1);

        if (amount === 0) {
          // Delete entry if charge is 0
          if (existingCharge.length > 0) {
            await tx.delete(containerCharges).where(eq(containerCharges.id, existingCharge[0].id));
          }
        } else {
          // Upsert: update if exists, insert if not
          if (existingCharge.length > 0) {
            await tx
              .update(containerCharges)
              .set({ amount: amount.toFixed(2) })
              .where(eq(containerCharges.id, existingCharge[0].id));
          } else {
            await tx.insert(containerCharges).values({
              containerId: existingPO.containerId,
              chargeType: chargeType,
              amount: amount.toFixed(2),
            });
          }
        }
      }
    }
  });

  // ── Post-transaction interco sync (backup / belt-and-suspenders) ──────
  // The in-transaction sync above uses `tx`, which can silently fail if the
  // transaction encounters a locking issue.  This second sync runs OUTSIDE
  // the transaction using the plain `db` handle — identical to the pattern
  // used by the charges-only path — so the parent INTERCO-PARENT JV is
  // guaranteed to be up-to-date even if the in-transaction call was a no-op.
  if (_b1GrandTotalForSync > 0) {
    const _b1PostParentId = await storage.getParentCompanyId();
    if (_b1PostParentId && existingPO.companyId !== _b1PostParentId) {
      const _b1PostSync = await syncIntercoParentVoucher(
        db,
        _b1PoNumsForSync,
        _b1GrandTotalForSync,
        _b1ContainerNumForSync,
        _b1HasParentFreightForSync && _b1FreightParentAccountIdForSync
          ? {
              freightAmount: _b1FreightForSync,
              freightParentAccountId: _b1FreightParentAccountIdForSync,
              subsidiaryCompanyId: existingPO.companyId,
            }
          : undefined
      );
      if (!_b1PostSync.found) {
        logger.warn(
          `[PO-PATCH items post-tx] No INTERCO-PARENT voucher found for PO(s): ${Array.isArray(_b1PoNumsForSync) ? _b1PoNumsForSync.join(", ") : _b1PoNumsForSync}`
        );
      } else if (_b1PostSync.updated) {
        logger.info(
          `[PO-PATCH items post-tx] Updated parent JV #${_b1PostSync.voucherId}: ${_b1PostSync.oldAmount} → ${_b1PostSync.amount}`
        );
      }
    }
  }

  // Get updated PO with items
  const updatedPO = await storage.getPurchaseOrderByIdForCompany(id, existingPO.companyId);
  const lineItems = await storage.getLineItemsByPO(id);
  const supplier = await storage.getSupplierById(existingPO.supplierId);
  const container = await storage.getContainerByIdForCompany(existingPO.containerId, existingPO.companyId);

  try {
    const _poItemChanges: Record<string, { old?: unknown; new?: unknown }> = {};
    const _oldItemMap = new Map(existingLineItems.map((it) => [it.id, it]));
    const _addedItems: string[] = [];
    const _removedItems: string[] = [];
    const _changedItems: string[] = [];
    for (const newIt of lineItems) {
      if (newIt.id && _oldItemMap.has(newIt.id)) {
        const oldIt = _oldItemMap.get(newIt.id)!;
        const diffs: string[] = [];
        if (String(oldIt.quantity ?? "") !== String(newIt.quantity ?? ""))
          diffs.push(`qty: ${oldIt.quantity}→${newIt.quantity}`);
        if (String(oldIt.rate ?? "") !== String(newIt.rate ?? "")) diffs.push(`price changed`);
        if (diffs.length) _changedItems.push(`${newIt.stockItemId}: ${diffs.join(", ")}`);
      } else {
        _addedItems.push(String(newIt.stockItemId || "new"));
      }
    }
    const _newIdSet = new Set(lineItems.filter((it) => it.id).map((it) => it.id));
    for (const [oldId, _oldIt] of _oldItemMap) {
      if (!_newIdSet.has(oldId)) _removedItems.push(String(oldId));
    }
    if (_addedItems.length) _poItemChanges.itemsAdded = { new: _addedItems.join(", ") };
    if (_removedItems.length) _poItemChanges.itemsRemoved = { old: _removedItems.join(", ") };
    if (_changedItems.length) _poItemChanges.itemsChanged = { new: _changedItems.join("; ") };
    if (existingPO.poNumber !== updatedPO?.poNumber)
      _poItemChanges.poNumber = { old: existingPO.poNumber, new: updatedPO?.poNumber };
    if (existingPO.itemsTotal !== updatedPO?.itemsTotal)
      _poItemChanges.itemsTotal = { old: existingPO.itemsTotal, new: updatedPO?.itemsTotal };
    await logAudit({
      userId: req.session.userId!,
      username: req.session.username || "unknown",
      companyId: req.session.currentCompanyId!,
      action: "update",
      tableName: "purchase_orders",
      recordId: id,
      recordIdentifier: existingPO.poNumber || `PO #${id}`,
      changes: _poItemChanges,
    });
  } catch {
    /* non-fatal */
  }

  // INTERCO-FREIGHT sync removed — freight is now inside the purchase voucher itself.

  return {
    ...updatedPO,
    items: lineItems,
    supplierName: supplier?.legalName || "Unknown Supplier",
    supplierCode: supplier?.code || "",
    containerNumber: container?.containerNumber || "",
  };
}
