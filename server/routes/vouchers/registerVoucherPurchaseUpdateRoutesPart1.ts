// Extracted from ./voucherPurchaseUpdateRoutes.ts
import type { Express } from "express";
import { getErrorMessage, errorStatus, HttpError } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { buildItemLevelChanges } from "../_helpers";
import { containers, purchaseOrders, poLineItems, vouchers, voucherEntries } from "@shared/schema";
import { eq } from "drizzle-orm";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";
import type Decimal from "decimal.js";
import { parseMoneyInput, sumMoney, toMoney } from "../../lib/money";
import { syncPurchaseOrderGitTx } from "../../services/accounting/perpetualInventory/stockReceipts";
import { assertHistoricalUsdPurchaseCost } from "../../services/accounting/zambiaPurchaseCurrencyGuard";
import {
  assertVoucherEditableTx,
  recordVoucherEditAuditTx,
  sendVoucherCorrectionRefusal,
} from "../../services/accounting/voucherCorrection";

/** The columns a voucher edit may set, checked against the vouchers table. */
type VoucherUpdate = PgUpdateSetSource<typeof vouchers>;

/**
 * Each line's quantity and rate as exact Decimals, read as parseFloat reads
 * them; null when any line does not parse, which used to be written as NaN.
 */
export function parseItemAmounts(items: Array<{ quantity: unknown; rate: unknown }>) {
  const parsed: Array<{ quantity: Decimal; rate: Decimal }> = [];
  for (const item of items) {
    const quantity = parseMoneyInput(item.quantity);
    const rate = parseMoneyInput(item.rate);
    if (!quantity || !rate) return null;
    parsed.push({ quantity, rate });
  }
  return parsed;
}

export function registerVoucherPurchaseUpdateRoutesPart1(app: Express) {
  app.patch("/api/vouchers/:id/purchase", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid voucher ID" });
      const { voucherDate, description, items } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }
      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) return res.status(404).json({ message: "Voucher not found" });
      if (existingVoucher.voucherType !== "Purchase") {
        return res.status(400).json({ message: "This endpoint only updates Purchase vouchers" });
      }
      if (existingVoucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Voucher belongs to a different company" });
      }
      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }
      const userRole = req.session.currentRole;
      if (!userRole) return res.status(403).json({ message: "User role not found" });
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        if (userRole === "Manager") {
          const today = new Date();
          today.setHours(0, 0, 0, 0);
          const existingDate = new Date(existingVoucher.voucherDate);
          existingDate.setHours(0, 0, 0, 0);
          if (existingDate.getTime() !== today.getTime()) {
            return res.status(403).json({ message: "Managers can only edit today's vouchers" });
          }
        } else {
          return res.status(403).json({ message: "Insufficient permissions to edit vouchers" });
        }
      }

      const [po] = await db.select().from(purchaseOrders).where(eq(purchaseOrders.voucherId, id)).limit(1);
      if (!po) return res.status(404).json({ message: "Associated purchase order not found" });
      assertHistoricalUsdPurchaseCost(po.currency);
      const amounts = parseItemAmounts(items);
      if (!amounts) return res.status(400).json({ message: "Invalid amount" });
      const lineTotals = amounts.map(({ quantity, rate }) => quantity.times(rate));
      const totalAmount = sumMoney(lineTotals);
      const poItemsData = items.map((item, index) => {
        const lineTotal = lineTotals[index];
        return {
          poId: po.id,
          stockItemId: item.stockItemId || 0,
          itemName: item.itemName,
          quantity: item.quantity,
          rate: item.rate,
          lineTotal: lineTotal.toFixed(2),
        };
      });

      // Wave 7: line items, PO, container totals, the voucher and its lines,
      // goods in transit and the audit row commit together. Before, each was an
      // autocommit write and the voucher's lines were never changed, so the
      // header total disagreed with its lines after an edit.
      const updated = await db.transaction(async (tx) => {
        if (po.containerId != null) {
          await tx
            .select({ id: containers.id })
            .from(containers)
            .where(eq(containers.id, po.containerId))
            .for("update");
        }
        const [lockedPO] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, po.id)).for("update");
        if (!lockedPO || lockedPO.voucherId !== id) {
          throw new HttpError(409, "Purchase order changed concurrently. Reload and try again.");
        }
        // Phase 22 (B), PE9/G4: open-period edit, audited below; closed period → 409.
        const editContext = await assertVoucherEditableTx(tx, id, {
          companyId: existingVoucher.companyId,
          newVoucherDate: voucherDate ?? null,
        });
        const oldPOTotal = toMoney(lockedPO.itemsTotal);
        const difference = totalAmount.minus(oldPOTotal);

        const _oldPOItems = await tx.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
        await tx.delete(poLineItems).where(eq(poLineItems.poId, po.id));
        await tx.insert(poLineItems).values(poItemsData);
        await tx
          .update(purchaseOrders)
          .set({ itemsTotal: totalAmount.toFixed(2) })
          .where(eq(purchaseOrders.id, po.id));

        const [container] = await tx.select().from(containers).where(eq(containers.id, po.containerId)).limit(1);
        if (container) {
          const newContainerItemsTotal = toMoney(container.itemsTotal).plus(difference);
          const newContainerGrandTotal = newContainerItemsTotal.plus(toMoney(container.chargesTotal));
          await tx
            .update(containers)
            .set({ itemsTotal: newContainerItemsTotal.toFixed(2), grandTotal: newContainerGrandTotal.toFixed(2) })
            .where(eq(containers.id, po.containerId));
        }

        // The voucher carries the PO's charges as well as its items, so the item
        // change moves the goods lines (first purchases debit, first non-freight
        // credit) and the voucher total by the same difference; freight lines are
        // left as they are. The voucher stays balanced.
        const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));
        // A voucher with no lines posts nothing; only its header total follows the PO, as before.
        if (!difference.isZero() && entries.length > 0) {
          const freightAccountIds = new Set(
            [lockedPO.freightOwnAccountId, lockedPO.freightParentAccountId].filter((v): v is number => v != null)
          );
          const isFreight = (entry: (typeof entries)[number]) =>
            (entry.ledgerAccountId != null && freightAccountIds.has(entry.ledgerAccountId)) ||
            (entry.narration ?? "").startsWith("Freight");
          const goodsDebit = entries.find((e) => toMoney(e.debitAmount).gt(0) && !isFreight(e));
          const goodsCredit = entries.find((e) => toMoney(e.creditAmount).gt(0) && !isFreight(e));
          if (!goodsDebit || !goodsCredit) {
            throw new HttpError(
              409,
              "The purchase voucher has no goods lines to adjust; edit the purchase order instead."
            );
          }
          const newDebit = toMoney(goodsDebit.debitAmount).plus(difference);
          const newCredit = toMoney(goodsCredit.creditAmount).plus(difference);
          if (newDebit.lt(0) || newCredit.lt(0)) {
            throw new HttpError(400, "The new items total is below the purchase voucher's other lines");
          }
          await tx
            .update(voucherEntries)
            .set({ debitAmount: newDebit.toFixed(2) })
            .where(eq(voucherEntries.id, goodsDebit.id));
          await tx
            .update(voucherEntries)
            .set({ creditAmount: newCredit.toFixed(2) })
            .where(eq(voucherEntries.id, goodsCredit.id));
        }

        // The header total is the voucher's debit side as it now stands.
        const finalEntries = await tx
          .select({ debitAmount: voucherEntries.debitAmount })
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, id));
        const voucherUpdates: VoucherUpdate = {
          totalAmount:
            finalEntries.length > 0
              ? sumMoney(finalEntries.map((e) => e.debitAmount)).toFixed(2)
              : totalAmount.toFixed(2),
        };
        if (voucherDate !== undefined) voucherUpdates.voucherDate = voucherDate;
        if (description !== undefined) voucherUpdates.description = description;
        const updatedRows = await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();
        // Perpetual inventory (wave 8.2): goods in transit follows the edited PO voucher.
        await syncPurchaseOrderGitTx(tx, existingVoucher.companyId, po.id);
        const _purChanges: Record<string, { old: unknown; new: unknown }> = {};
        if (existingVoucher.voucherDate !== updatedRows[0].voucherDate)
          _purChanges.date = { old: existingVoucher.voucherDate, new: updatedRows[0].voucherDate };
        if (existingVoucher.totalAmount !== updatedRows[0].totalAmount)
          _purChanges.totalAmount = { old: existingVoucher.totalAmount, new: updatedRows[0].totalAmount };
        if (existingVoucher.description !== updatedRows[0].description)
          _purChanges.description = { old: existingVoucher.description ?? "", new: updatedRows[0].description ?? "" };
        const _itemDiff = await buildItemLevelChanges(
          _oldPOItems.map((it) => ({
            stockItemId: it.stockItemId,
            itemName: it.itemName,
            quantity: it.quantity,
            rate: it.rate,
            lineTotal: it.lineTotal,
          })),
          poItemsData.map((it) => ({
            stockItemId: it.stockItemId,
            itemName: it.itemName,
            quantity: it.quantity,
            rate: it.rate,
            lineTotal: it.lineTotal,
          }))
        );
        // Phase 22 (B): one audit row — the full before/after snapshot of the
        // correction policy with the readable PO changes.
        await recordVoucherEditAuditTx(tx, {
          voucherId: id,
          before: editContext.before,
          actor: { userId: req.session.userId, username: req.session.username, companyId: existingVoucher.companyId },
          reason: "Purchase voucher update",
          extra: { ..._purChanges, ..._itemDiff },
        });
        return updatedRows;
      });
      res.json(updated[0]);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      const status = error instanceof HttpError ? error.statusCode : errorStatus(error);
      res.status(status).json({ message: getErrorMessage(error) });
    }
  });
}
