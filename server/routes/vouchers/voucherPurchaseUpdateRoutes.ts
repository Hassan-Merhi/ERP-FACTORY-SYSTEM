import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit, buildItemLevelChanges } from "../_helpers";
import {
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  containers,
  purchaseOrders,
  poLineItems,
  vouchers,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { adjustInventory } from "../../inventoryHelper";
import { nextCanonicalSourceRevision } from "../../services/inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

/** The columns a voucher edit may set, checked against the vouchers table. */
type VoucherUpdate = PgUpdateSetSource<typeof vouchers>;

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

/**
 * After saving a journal voucher, if it has a customer entry + a ledger account entry,
 * look for order charges linked to that ledger account for that customer.
 * If exactly one charge is found, update its amount and recalculate the order totals.
 */

export function registerVoucherPurchaseUpdateRoutes(app: Express) {
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
      const oldPOTotal = parseFloat(po.itemsTotal || "0");
      let totalAmount = 0;
      const poItemsData = items.map((item) => {
        const quantity = parseFloat(item.quantity);
        const rate = parseFloat(item.rate);
        const lineTotal = quantity * rate;
        totalAmount += lineTotal;
        return {
          poId: po.id,
          stockItemId: item.stockItemId || 0,
          itemName: item.itemName,
          quantity: item.quantity,
          rate: item.rate,
          lineTotal: lineTotal.toFixed(2),
        };
      });

      const _oldPOItems = await db.select().from(poLineItems).where(eq(poLineItems.poId, po.id));
      await db.delete(poLineItems).where(eq(poLineItems.poId, po.id));
      await db.insert(poLineItems).values(poItemsData);
      await db
        .update(purchaseOrders)
        .set({ itemsTotal: totalAmount.toFixed(2) })
        .where(eq(purchaseOrders.id, po.id));

      const [container] = await db.select().from(containers).where(eq(containers.id, po.containerId)).limit(1);
      if (container) {
        const containerItemsTotal = parseFloat(container.itemsTotal || "0");
        const containerChargesTotal = parseFloat(container.chargesTotal || "0");
        const difference = totalAmount - oldPOTotal;
        const newContainerItemsTotal = containerItemsTotal + difference;
        const newContainerGrandTotal = newContainerItemsTotal + containerChargesTotal;
        await db
          .update(containers)
          .set({ itemsTotal: newContainerItemsTotal.toFixed(2), grandTotal: newContainerGrandTotal.toFixed(2) })
          .where(eq(containers.id, po.containerId));
      }

      const voucherUpdates: VoucherUpdate = { totalAmount: totalAmount.toFixed(2) };
      if (voucherDate !== undefined) voucherUpdates.voucherDate = voucherDate;
      if (description !== undefined) voucherUpdates.description = description;
      const updated = await db.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();

      try {
        const _purChanges: Record<string, any> = {};
        if (existingVoucher.voucherDate !== updated[0].voucherDate)
          _purChanges.date = { old: existingVoucher.voucherDate, new: updated[0].voucherDate };
        if (existingVoucher.totalAmount !== updated[0].totalAmount)
          _purChanges.totalAmount = { old: existingVoucher.totalAmount, new: updated[0].totalAmount };
        if (existingVoucher.description !== updated[0].description)
          _purChanges.description = { old: existingVoucher.description ?? "", new: updated[0].description ?? "" };
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
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: updated[0].id,
          recordIdentifier: updated[0].voucherNumber,
          changes: { ..._purChanges, ..._itemDiff },
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated[0]);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/vouchers/:id/adjustment", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) return res.status(400).json({ message: "Invalid voucher ID" });
      const { voucherDate, description, locationId, items } = req.body;
      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }
      if (!locationId) return res.status(400).json({ message: "Location ID is required" });

      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) return res.status(404).json({ message: "Voucher not found" });
      if (!["Consumption", "Production", "Mixed"].includes(existingVoucher.voucherType)) {
        return res
          .status(400)
          .json({ message: "This endpoint only updates Consumption, Production, or Mixed vouchers" });
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

      let adjustmentVoucher = await db
        .select()
        .from(stockAdjustmentVouchers)
        .where(eq(stockAdjustmentVouchers.voucherId, id))
        .limit(1)
        .then((rows) => rows[0]);
      const _oldAdjItems = adjustmentVoucher
        ? await db
            .select()
            .from(stockAdjustmentItems)
            .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id))
        : [];
      if (!adjustmentVoucher) {
        let adjustmentType = "production";
        if (existingVoucher.voucherType === "Consumption") adjustmentType = "consumption";
        else if (existingVoucher.voucherType === "Mixed") adjustmentType = "mixed";
        const [newAdjustment] = await db
          .insert(stockAdjustmentVouchers)
          .values({ voucherId: id, locationId: parseInt(locationId), adjustmentType, notes: description || "" })
          .returning();
        adjustmentVoucher = newAdjustment;
      }

      let signedTotal = 0;
      const adjustmentItemsData = items.map((item) => {
        const quantity = parseFloat(item.quantity);
        const rate = parseFloat(item.rate);
        const absItemTotal = Math.abs(quantity) * rate;
        signedTotal += quantity * rate;
        return {
          adjustmentId: adjustmentVoucher.id,
          stockItemId: item.stockItemId,
          quantity: item.quantity,
          rate: item.rate,
          totalAmount: absItemTotal.toFixed(2),
        };
      });
      const totalAmount = existingVoucher.voucherType === "Mixed" ? signedTotal : Math.abs(signedTotal);

      const updated = await db.transaction(async (tx) => {
        const oldAdjustmentItems = await tx
          .select()
          .from(stockAdjustmentItems)
          .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));
        const oldLocationId = adjustmentVoucher.locationId;
        const revision = await nextCanonicalSourceRevision(
          tx,
          existingVoucher.companyId,
          "voucher-adjustment-edit",
          String(id)
        );
        const occurredAt = new Date().toISOString();
        const actor = {
          userId: req.session.userId,
          username: req.session.username,
          reason: `Edit adjustment voucher ${existingVoucher.voucherNumber}`,
        };

        for (const oldItem of oldAdjustmentItems) {
          const quantity = parseFloat(oldItem.quantity);
          const rate = parseFloat(oldItem.rate);
          await adjustInventory(tx, oldLocationId, oldItem.stockItemId, -quantity, existingVoucher.companyId);
          const reversalDelta = -quantity;
          await postStockMovementTx(
            tx,
            {
              companyId: existingVoucher.companyId,
              stockItemId: oldItem.stockItemId,
              kind: "adjustment",
              quantity: String(Math.abs(quantity)),
              unitCost: String(Math.max(rate || 0, 0)),
              fromLocationId: reversalDelta < 0 ? oldLocationId : undefined,
              toLocationId: reversalDelta > 0 ? oldLocationId : undefined,
              occurredAt,
              source: {
                sourceType: "voucher-adjustment-edit-reverse",
                sourceId: String(id),
                idempotencyKey: `voucher-adjustment-edit:rev${revision}:reverse:${oldItem.id}`,
              },
              actor,
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        await tx.delete(stockAdjustmentItems).where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));
        const newLocationId = parseInt(locationId);

        for (let index = 0; index < adjustmentItemsData.length; index += 1) {
          const newItem = adjustmentItemsData[index];
          const quantity = parseFloat(newItem.quantity);
          const rate = parseFloat(newItem.rate);
          await adjustInventory(tx, newLocationId, newItem.stockItemId, quantity, existingVoucher.companyId, rate);
          await postStockMovementTx(
            tx,
            {
              companyId: existingVoucher.companyId,
              stockItemId: newItem.stockItemId,
              kind: "adjustment",
              quantity: String(Math.abs(quantity)),
              unitCost: String(Math.max(rate || 0, 0)),
              fromLocationId: quantity < 0 ? newLocationId : undefined,
              toLocationId: quantity > 0 ? newLocationId : undefined,
              occurredAt,
              source: {
                sourceType: "voucher-adjustment-edit-apply",
                sourceId: String(id),
                idempotencyKey: `voucher-adjustment-edit:rev${revision}:apply:${index}:${newItem.stockItemId}`,
              },
              actor,
              allowNegativeStock: true,
            },
            canonicalStockMovementAdapter
          );
        }

        await tx.insert(stockAdjustmentItems).values(adjustmentItemsData);
        await tx
          .update(stockAdjustmentVouchers)
          .set({ locationId: newLocationId, notes: description || "" })
          .where(eq(stockAdjustmentVouchers.id, adjustmentVoucher.id));

        const parsedLocationId = newLocationId;
        const voucherUpdates: VoucherUpdate = { totalAmount: totalAmount.toFixed(2), locationId: parsedLocationId };
        const location = await storage.getLocationById(parsedLocationId);
        if (location) voucherUpdates.locationName = location.name;
        if (voucherDate !== undefined) voucherUpdates.voucherDate = voucherDate;
        if (description !== undefined) voucherUpdates.description = description;
        const [updatedVoucher] = await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();
        return updatedVoucher;
      });

      try {
        const _adjChanges: Record<string, any> = {};
        if (existingVoucher.voucherDate !== updated.voucherDate)
          _adjChanges.date = { old: existingVoucher.voucherDate, new: updated.voucherDate };
        if (existingVoucher.totalAmount !== updated.totalAmount)
          _adjChanges.totalAmount = { old: existingVoucher.totalAmount, new: updated.totalAmount };
        if (existingVoucher.locationId !== updated.locationId)
          _adjChanges.location = { old: existingVoucher.locationId, new: updated.locationId };
        if ((existingVoucher.description ?? "") !== (updated.description ?? ""))
          _adjChanges.description = { old: existingVoucher.description ?? "", new: updated.description ?? "" };
        const _resolveAdjName = async (itemId: number) =>
          (await storage.getStockItemById(itemId))?.name ?? `Item #${itemId}`;
        const _adjItemDiff = await buildItemLevelChanges(
          _oldAdjItems.map((it) => ({
            stockItemId: it.stockItemId,
            quantity: it.quantity,
            rate: it.rate,
            totalAmount: it.totalAmount,
          })),
          adjustmentItemsData.map((it) => ({
            stockItemId: it.stockItemId,
            quantity: it.quantity,
            rate: it.rate,
            totalAmount: it.totalAmount,
          })),
          _resolveAdjName
        );
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: updated.id,
          recordIdentifier: updated.voucherNumber,
          changes: { ..._adjChanges, ..._adjItemDiff },
        });
      } catch {
        /* non-fatal */
      }
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update a stock transfer voucher with line items
}
