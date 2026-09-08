/**
 * voucherTransferRoutes: VoucherTransferOnly endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { logAudit, buildItemLevelChanges } from "../../_helpers";
import { stockTransferVouchers, stockTransferItems, vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

/** The columns a voucher edit may set, checked against the vouchers table. */
type VoucherUpdate = PgUpdateSetSource<typeof vouchers>;

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerVoucherTransferOnlyRoutes(app: Express) {
  app.patch("/api/vouchers/:id/transfer", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const { voucherDate, description, sourceLocationId, destinationLocationId, items } = req.body;

      if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ message: "At least one item is required" });
      }

      if (!sourceLocationId || !destinationLocationId) {
        return res.status(400).json({ message: "Source and destination locations are required" });
      }

      // Get the existing voucher to check company and permissions
      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      // Verify this is a Stock Transfer voucher
      if (existingVoucher.voucherType !== "Stock Transfer") {
        return res.status(400).json({
          message: "This endpoint only updates Stock Transfer vouchers",
        });
      }

      // Verify voucher belongs to current company
      if (existingVoucher.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Voucher belongs to a different company",
        });
      }

      const blockedVoucherReason = voucherMutationBlockReason(existingVoucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      // Check edit permissions
      const userRole = req.session.currentRole;
      if (!userRole) {
        return res.status(403).json({ message: "User role not found" });
      }

      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        if (userRole === "Manager") {
          const today = new Date();
          today.setHours(0, 0, 0, 0);

          const voucherDate = new Date(existingVoucher.voucherDate);
          voucherDate.setHours(0, 0, 0, 0);

          if (voucherDate.getTime() !== today.getTime()) {
            return res.status(403).json({ message: "Managers can only edit today's vouchers" });
          }
        } else {
          return res.status(403).json({ message: "Insufficient permissions to edit vouchers" });
        }
      }

      logger.info(`[Stock Transfer Edit] Starting update for voucher ${id}`);

      // Snapshot old transfer items before the transaction mutates them
      const _preTransfer = await db
        .select()
        .from(stockTransferVouchers)
        .where(eq(stockTransferVouchers.voucherId, id))
        .limit(1)
        .then((rows) => rows[0]);
      const _oldXfrItems = _preTransfer
        ? await db.select().from(stockTransferItems).where(eq(stockTransferItems.transferId, _preTransfer.id))
        : [];
      const editOperationId = randomUUID();
      const occurredAt = new Date().toISOString();

      // Wrap the entire operation in a transaction for atomicity
      const { updatedVoucher: updated, transferItemsData: updatedTransferItemsData } = await db.transaction(
        async (tx) => {
          // Find or create the associated transfer voucher
          let transferVoucher = await tx
            .select()
            .from(stockTransferVouchers)
            .where(eq(stockTransferVouchers.voucherId, id))
            .limit(1)
            .then((rows) => rows[0]);

          // If no transfer voucher exists, create one
          if (!transferVoucher) {
            const [newTransfer] = await tx
              .insert(stockTransferVouchers)
              .values({
                voucherId: id,
                sourceLocationId: parseInt(sourceLocationId),
                destinationLocationId: parseInt(destinationLocationId),
                notes: description || "",
              })
              .returning();
            transferVoucher = newTransfer;
          }

          // Calculate totals and prepare items data
          let totalAmount = 0;

          const transferItemsData = items.map((item) => {
            const quantity = parseFloat(item.quantity);
            const rate = parseFloat(item.rate);
            const itemTotal = quantity * rate;

            totalAmount += itemTotal;

            return {
              transferId: transferVoucher.id,
              stockItemId: item.stockItemId,
              quantity: item.quantity,
              rate: item.rate,
              totalAmount: itemTotal.toFixed(2),
              sourceLocationId: parseInt(sourceLocationId),
            };
          });

          // STEP 1: Reverse inventory for old transfer items before deleting
          const oldTransferItems = await tx
            .select()
            .from(stockTransferItems)
            .where(eq(stockTransferItems.transferId, transferVoucher.id));

          const oldSourceLocationId = transferVoucher.sourceLocationId;
          const oldDestinationLocationId = transferVoucher.destinationLocationId;
          if (oldSourceLocationId == null || oldDestinationLocationId == null) {
            throw new Error("Existing stock transfer is missing source or destination location");
          }

          for (const oldItem of oldTransferItems) {
            const quantity = parseFloat(oldItem.quantity);
            const rate = parseFloat(oldItem.rate);

            // Add back to source location (reverse the subtraction)
            await adjustInventory(
              tx,
              oldSourceLocationId,
              oldItem.stockItemId,
              quantity,
              existingVoucher.companyId!,
              rate
            );

            // Subtract from destination location (reverse the addition)
            await adjustInventory(
              tx,
              oldDestinationLocationId,
              oldItem.stockItemId,
              -quantity,
              existingVoucher.companyId!
            );

            await postStockMovementTx(
              tx,
              {
                companyId: existingVoucher.companyId!,
                stockItemId: oldItem.stockItemId,
                kind: "transfer",
                quantity: String(quantity),
                unitCost: String(Math.max(rate || 0, 0)),
                fromLocationId: oldDestinationLocationId,
                toLocationId: oldSourceLocationId,
                occurredAt,
                source: {
                  sourceType: "voucher_stock_transfer_edit_reverse",
                  sourceId: String(id),
                  idempotencyKey: `voucher-transfer-edit:reverse:${existingVoucher.companyId}:${id}:${oldItem.id}`,
                },
                actor: {
                  userId: req.session.userId,
                  username: req.session.username,
                  reason: `Edit stock transfer ${existingVoucher.voucherNumber}`,
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }

          // STEP 2: Delete existing transfer items
          await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferVoucher.id));

          // STEP 3: Apply inventory for new transfer items
          const newSourceLocationId = parseInt(sourceLocationId);
          const newDestinationLocationId = parseInt(destinationLocationId);

          for (let index = 0; index < transferItemsData.length; index++) {
            const newItem = transferItemsData[index];
            const quantity = parseFloat(newItem.quantity);
            const rate = parseFloat(newItem.rate);

            // Subtract from new source location
            await adjustInventory(tx, newSourceLocationId, newItem.stockItemId, -quantity, existingVoucher.companyId);

            // Add to new destination location
            await adjustInventory(
              tx,
              newDestinationLocationId,
              newItem.stockItemId,
              quantity,
              existingVoucher.companyId,
              rate
            );

            await postStockMovementTx(
              tx,
              {
                companyId: existingVoucher.companyId!,
                stockItemId: newItem.stockItemId,
                kind: "transfer",
                quantity: String(quantity),
                unitCost: String(Math.max(rate || 0, 0)),
                fromLocationId: newSourceLocationId,
                toLocationId: newDestinationLocationId,
                occurredAt,
                source: {
                  sourceType: "voucher_stock_transfer_edit_apply",
                  sourceId: String(id),
                  idempotencyKey: `voucher-transfer-edit:apply:${existingVoucher.companyId}:${id}:${editOperationId}:${index}`,
                },
                actor: {
                  userId: req.session.userId,
                  username: req.session.username,
                  reason: `Edit stock transfer ${existingVoucher.voucherNumber}`,
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }

          // STEP 4: Insert new transfer items
          await tx.insert(stockTransferItems).values(transferItemsData);

          // Update the transfer voucher (locations can be changed, but shouldn't affect old inventory)
          await tx
            .update(stockTransferVouchers)
            .set({
              sourceLocationId: parseInt(sourceLocationId),
              destinationLocationId: parseInt(destinationLocationId),
              notes: description || "",
            })
            .where(eq(stockTransferVouchers.id, transferVoucher.id));

          // Update the main voucher
          const parsedSourceLocationId = parseInt(sourceLocationId);
          const voucherUpdates: VoucherUpdate = {
            totalAmount: totalAmount.toFixed(2),
            locationId: parsedSourceLocationId, // Use source location as the primary location for the voucher
          };
          // Also save the location name for when the location is later deleted
          const sourceLocation = await storage.getLocationById(parsedSourceLocationId);
          if (sourceLocation) {
            voucherUpdates.locationName = sourceLocation.name;
          }
          if (voucherDate !== undefined) voucherUpdates.voucherDate = voucherDate;
          if (description !== undefined) voucherUpdates.description = description;

          const [updatedVoucher] = await tx.update(vouchers).set(voucherUpdates).where(eq(vouchers.id, id)).returning();

          return { updatedVoucher, transferItemsData };
        }
      );

      try {
        const _xfrChanges: Record<string, any> = {};
        if (existingVoucher.voucherDate !== updated.voucherDate)
          _xfrChanges.date = { old: existingVoucher.voucherDate, new: updated.voucherDate };
        if (existingVoucher.totalAmount !== updated.totalAmount)
          _xfrChanges.totalAmount = { old: existingVoucher.totalAmount, new: updated.totalAmount };
        if (_preTransfer && parseInt(sourceLocationId) !== _preTransfer.sourceLocationId)
          _xfrChanges.sourceLocation = { old: _preTransfer.sourceLocationId, new: parseInt(sourceLocationId) };
        if (_preTransfer && parseInt(destinationLocationId) !== _preTransfer.destinationLocationId)
          _xfrChanges.destinationLocation = {
            old: _preTransfer.destinationLocationId,
            new: parseInt(destinationLocationId),
          };
        if ((existingVoucher.description ?? "") !== (updated.description ?? ""))
          _xfrChanges.description = { old: existingVoucher.description ?? "", new: updated.description ?? "" };
        const _resolveXfrName = async (id: number) => (await storage.getStockItemById(id))?.name ?? `Item #${id}`;
        const _xfrItemDiff = await buildItemLevelChanges(
          _oldXfrItems.map((it) => ({
            stockItemId: it.stockItemId,
            quantity: it.quantity,
            rate: it.rate,
            totalAmount: it.totalAmount,
          })),
          updatedTransferItemsData.map((it) => ({
            stockItemId: it.stockItemId,
            quantity: it.quantity,
            rate: it.rate,
            totalAmount: it.totalAmount,
          })),
          _resolveXfrName
        );
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "update",
          tableName: "vouchers",
          recordId: updated.id,
          recordIdentifier: updated.voucherNumber,
          changes: { ..._xfrChanges, ..._xfrItemDiff },
        });
      } catch {
        /* non-fatal */
      }
      logger.info(`[Stock Transfer Edit] Successfully updated voucher ${id}`);
      res.json(updated);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
