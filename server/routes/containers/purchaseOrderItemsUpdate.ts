import type { Request } from "express";
import { eq, and } from "drizzle-orm";

import { containers, containerCharges, purchaseOrders, poLineItems, vouchers, voucherEntries } from "@shared/schema";

import { db } from "../../db";
import { storage } from "../../storage";
import { logAudit } from "../_helpers";
import { HttpError } from "../../lib/httpHandlers";
import { syncIntercoParentVoucher } from "./containerHelpers";
import { toMoney } from "../../lib/money";
import { syncPurchaseOrderGitTx } from "../../services/accounting/perpetualInventory/stockReceipts";
import { usdLineAmounts } from "../../services/factory/factoryVoucherPosting";
import { editPostedFactoryVoucherTx } from "../../services/factory/factoryVoucherCorrection";
import { runWithVerifiedPoParentScope } from "../../services/security/parentCompanyPostingScope";
import { cents } from "./purchaseOrderItemsUpdateHelpers";
import { purchaseOrderItemsUpdateStep } from "./purchaseOrderItemsUpdateStep";
import { purchaseOrderItemsUpdateStep2 } from "./purchaseOrderItemsUpdateStep2";

type PurchaseOrderRecord = NonNullable<Awaited<ReturnType<typeof storage.getPurchaseOrderById>>>;

/**
 * A line item as the client sends it. Every field is optional and loosely typed
 * because the handler falls back to the stored row whenever one is missing or
 * blank, and accepts both string and number for the numeric fields.
 */
export interface PurchaseOrderItemInput {
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
  const poi1 = await purchaseOrderItemsUpdateStep({ ctx, req });
  const { existingPO, freight, id, surcharge, fumigation, documentCharges, discount, otherCharges, existingLineItems } =
    poi1;

  // Delete existing line items and create new ones in a transaction.
  // Lock order intentionally matches the offload lifecycle: container -> purchase order.
  // This prevents an offload from materializing inventory between the route pre-check
  // and the line-item rewrite.
  await runWithVerifiedPoParentScope(existingPO.companyId, (linkedParentCompanyId) =>
    db.transaction(async (tx) => {
      const poi2 = await purchaseOrderItemsUpdateStep2({ poi1, tx, req });
      const {
        hasRetiredPurchaseVoucher,
        b1IntercoTotal,
        b1FreightPaidBy,
        poGrandTotalExact,
        linkedVoucher,
        chargesWereEdited,
      } = poi2;

      // Update the associated voucher — use supplier share (intercoTotal) so freight excluded
      // when it's paid via own-account or parent-company voucher.
      if (existingPO.voucherId && !hasRetiredPurchaseVoucher) {
        const poVoucherId = existingPO.voucherId;
        // Phase 22 (C), G4: an audited open-period edit of the posted PO voucher
        // (409 in a closed period: reverse and re-post); every amount column.
        await editPostedFactoryVoucherTx(
          tx,
          {
            companyId: existingPO.companyId,
            voucherIds: [poVoucherId],
            reason: "purchase-order-items-update",
            actor: { userId: req.session.userId, username: req.session.username },
          },
          async () => {
            await tx.update(vouchers).set({ totalAmount: b1IntercoTotal }).where(eq(vouchers.id, poVoucherId));
            const existingEntries = await tx
              .select()
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, poVoucherId));
            for (const entry of existingEntries) {
              if (toMoney(entry.debitAmount).greaterThan(0)) {
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(b1IntercoTotal, 0))
                  .where(eq(voucherEntries.id, entry.id));
              } else if (toMoney(entry.creditAmount).greaterThan(0)) {
                await tx
                  .update(voucherEntries)
                  .set(usdLineAmounts(0, b1IntercoTotal))
                  .where(eq(voucherEntries.id, entry.id));
              }
            }
          }
        );
      }

      // ── Inter-company sync: only for true subsidiary POs (not same-company).
      // Freight for same-company POs is embedded directly in the PO voucher above.
      {
        const _b1ParentId = linkedParentCompanyId;
        if (!hasRetiredPurchaseVoucher && _b1ParentId && existingPO.companyId !== _b1ParentId) {
          const _b1FreightParentAccountId: number | null =
            req.body.freightParentAccountId !== undefined
              ? req.body.freightParentAccountId === null
                ? null
                : Number(req.body.freightParentAccountId)
              : (existingPO.freightParentAccountId ?? null);
          const _b1HasParentFreight =
            b1FreightPaidBy === "parent" && freight.greaterThan(0) && !!_b1FreightParentAccountId;
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
            poGrandTotalExact,
            _b1ContainerRow?.containerNumber,
            _b1HasParentFreight
              ? {
                  freightAmount: freight,
                  freightParentAccountId: _b1FreightParentAccountId!,
                  subsidiaryCompanyId: existingPO.companyId,
                }
              : undefined,
            _b1ParentId,
            existingPO.companyId,
            existingPO.supplierId && linkedVoucher?.voucherDate && linkedVoucher?.totalAmount
              ? {
                  purchaseOrderId: id,
                  supplierId: existingPO.supplierId,
                  originalVoucherDate: linkedVoucher.voucherDate,
                  originalVoucherTotal: linkedVoucher.totalAmount,
                }
              : undefined
          );
          if (!_b1Sync.found) {
            throw new HttpError(
              409,
              `Intercompany credit not synchronized for container ${_b1ContainerRow?.containerNumber ?? "unknown"} (PO ${existingPO.poNumber}). Parent journal missing; no changes saved.`
            );
          }
        }
      }

      // Sync container_charges table when PO charges are edited
      if (chargesWereEdited && existingPO.containerId) {
        const chargeTypeMap = [
          { field: "freight", chargeType: "Freight", amount: freight },
          { field: "surcharge", chargeType: "Surcharge", amount: surcharge },
          { field: "fumigation", chargeType: "Fumigation", amount: fumigation },
          { field: "documentCharges", chargeType: "Document Charges", amount: documentCharges },
          { field: "discount", chargeType: "Discount", amount: discount.negated() }, // Discount stored as negative
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

          if (amount.isZero()) {
            // Delete entry if charge is 0
            if (existingCharge.length > 0) {
              await tx.delete(containerCharges).where(eq(containerCharges.id, existingCharge[0].id));
            }
          } else {
            // Upsert: update if exists, insert if not
            if (existingCharge.length > 0) {
              await tx
                .update(containerCharges)
                .set({ amount: cents(amount) })
                .where(eq(containerCharges.id, existingCharge[0].id));
            } else {
              await tx.insert(containerCharges).values({
                containerId: existingPO.containerId,
                chargeType,
                amount: cents(amount),
              });
            }
          }
        }
      }
      // Perpetual inventory (wave 8.2): goods in transit follows the edited PO voucher.
      // Do not regenerate GIT from a retired voucher during the reversed-offload
      // editing window; the next offload must post a fresh live accounting source.
      if (!hasRetiredPurchaseVoucher) {
        await syncPurchaseOrderGitTx(tx, existingPO.companyId, existingPO.id);
      }

      // Wave 7: the audit row commits with the edit (it used to be written after
      // the commit, and its failure was swallowed). The in-transaction
      // inter-company sync above throws on failure, which rolls the whole edit
      // back, so the post-commit "backup" sync on the pool is gone.
      const [updatedRow] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, id)).limit(1);
      const newLineItems = await tx.select().from(poLineItems).where(eq(poLineItems.poId, id));
      const _poItemChanges: Record<string, { old?: unknown; new?: unknown }> = {};
      const _oldItemMap = new Map(existingLineItems.map((it) => [it.stockItemId, it]));
      const _newItemMap = new Map(newLineItems.map((it) => [it.stockItemId, it]));
      const _addedItems: string[] = [];
      const _removedItems: string[] = [];
      const _changedItems: string[] = [];
      for (const newIt of newLineItems) {
        const oldIt = _oldItemMap.get(newIt.stockItemId);
        if (oldIt) {
          const diffs: string[] = [];
          if (String(oldIt.quantity ?? "") !== String(newIt.quantity ?? ""))
            diffs.push(`qty: ${oldIt.quantity}→${newIt.quantity}`);
          if (String(oldIt.rate ?? "") !== String(newIt.rate ?? "")) diffs.push(`price changed`);
          if (diffs.length) _changedItems.push(`${newIt.stockItemId}: ${diffs.join(", ")}`);
        } else {
          _addedItems.push(String(newIt.stockItemId || "new"));
        }
      }
      for (const oldIt of existingLineItems) {
        if (!_newItemMap.has(oldIt.stockItemId)) _removedItems.push(String(oldIt.stockItemId));
      }
      if (_addedItems.length) _poItemChanges.itemsAdded = { new: _addedItems.join(", ") };
      if (_removedItems.length) _poItemChanges.itemsRemoved = { old: _removedItems.join(", ") };
      if (_changedItems.length) _poItemChanges.itemsChanged = { new: _changedItems.join("; ") };
      if (existingPO.poNumber !== updatedRow?.poNumber)
        _poItemChanges.poNumber = { old: existingPO.poNumber, new: updatedRow?.poNumber };
      if (existingPO.itemsTotal !== updatedRow?.itemsTotal)
        _poItemChanges.itemsTotal = { old: existingPO.itemsTotal, new: updatedRow?.itemsTotal };
      await logAudit(
        {
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "purchase_orders",
          recordId: id,
          recordIdentifier: existingPO.poNumber || `PO #${id}`,
          changes: _poItemChanges,
        },
        tx
      );
    })
  );

  // Get updated PO with items
  const updatedPO = await storage.getPurchaseOrderByIdForCompany(id, existingPO.companyId);
  const lineItems = await storage.getLineItemsByPO(id);
  const supplier = await storage.getSupplierById(existingPO.supplierId);
  const container = await storage.getContainerByIdForCompany(existingPO.containerId, existingPO.companyId);

  // INTERCO-FREIGHT sync removed — freight is now inside the purchase voucher itself.

  return {
    ...updatedPO,
    items: lineItems,
    supplierName: supplier?.legalName || "Unknown Supplier",
    supplierCode: supplier?.code || "",
    containerNumber: container?.containerNumber || "",
  };
}
