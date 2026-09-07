/**
 * voucherEntryRoutes: VoucherDelete endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import {
  logAudit,
  syncEmployeeBalancesFromEntries,
  snapshotVoucherEntries,
  buildVoucherChangesForDelete,
} from "../_helpers";
import {
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  vouchers,
  voucherEntries,
  salesItems,
  interCompanyTransfers,
  creditNoteItems,
  propertyPayments,
  intercompanyPaymentRequests,
} from "@shared/schema";
import { eq, and, or, sql } from "drizzle-orm";
import { adjustInventory } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerVoucherDeleteRoutes(app: Express) {
  // Delete a voucher (Admin only)
  app.delete("/api/vouchers/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get voucher and entries before deleting for balance sync
      const voucher = await storage.getVoucherById(id);
      if (!voucher) {
        return res.status(404).json({ message: "Voucher not found" });
      }

      const blockedVoucherReason = voucherMutationBlockReason(voucher);
      if (blockedVoucherReason) {
        return res.status(403).json({ message: blockedVoucherReason });
      }

      const companyId = req.session.currentCompanyId;
      const occurredAt = new Date().toISOString();

      // Wrap balance sync and deletion in a transaction
      await db.transaction(async (tx) => {
        // IMPORTANT: Reverse inventory movements for Stock Transfer vouchers
        // Note: Database stores as "StockTransfer" (no space), "Stock Transfer", or "Transfer" (POS-created)
        if (
          voucher.voucherType === "Stock Transfer" ||
          voucher.voucherType === "StockTransfer" ||
          voucher.voucherType === "Transfer"
        ) {
          // Get the stock transfer record
          const [transferVoucher] = await tx
            .select()
            .from(stockTransferVouchers)
            .where(eq(stockTransferVouchers.voucherId, id))
            .limit(1);

          // Reverse inventory if: inventory was explicitly applied (inventoryApplied=true)
          // OR voucher is non-optional (legacy behaviour before inventoryApplied column existed).
          // This ensures optional transfers that incorrectly applied inventory (old bug) are
          // also reversed on delete, while correctly-optional transfers (inventoryApplied=false)
          // are left alone.
          if (transferVoucher && (transferVoucher.inventoryApplied || !voucher.optional)) {
            // Get the transfer items
            const transferItemsList = await tx
              .select()
              .from(stockTransferItems)
              .where(eq(stockTransferItems.transferId, transferVoucher.id));

            // Reverse each item's inventory movement
            // NOTE: The forward transfer logic:
            // - Source: reduces qty, keeps existing averageRate
            // - Destination: adds qty with weighted average calculation
            // Reversal must be the exact inverse:
            // - Source: add back qty at existing rate (no average change needed)
            // - Destination: subtract qty and reverse the weighted average
            for (const item of transferItemsList) {
              const qty = parseFloat(item.quantity);
              const transferRate = parseFloat(item.rate);
              // Use per-item sourceLocationId (multi-source transfers may have different sources per item)
              const itemSourceId = item.sourceLocationId || transferVoucher.sourceLocationId!;

              // Add back to source location (reverse the deduction)
              await adjustInventory(tx, itemSourceId, item.stockItemId, qty, companyId, transferRate);

              // Remove from destination location (reverse the addition)
              await adjustInventory(tx, transferVoucher.destinationLocationId!, item.stockItemId, -qty, companyId);

              await postStockMovementTx(
                tx,
                {
                  companyId,
                  stockItemId: item.stockItemId,
                  kind: "transfer",
                  quantity: String(qty),
                  unitCost: String(Math.max(transferRate || 0, 0)),
                  fromLocationId: transferVoucher.destinationLocationId!,
                  toLocationId: itemSourceId,
                  occurredAt,
                  source: {
                    sourceType: "voucher_delete_stock_transfer",
                    sourceId: String(id),
                    idempotencyKey: `voucher-delete:transfer:${companyId}:${id}:${item.id}`,
                  },
                  actor: {
                    userId: req.session.userId,
                    username: req.session.username,
                    reason: `Delete voucher ${voucher.voucherNumber}`,
                  },
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }

          if (transferVoucher) {
            // Delete stock transfer items
            await tx.delete(stockTransferItems).where(eq(stockTransferItems.transferId, transferVoucher.id));

            // Delete stock transfer voucher record
            await tx.delete(stockTransferVouchers).where(eq(stockTransferVouchers.id, transferVoucher.id));
          }
        }

        // IMPORTANT: Reverse inventory movements for Stock Adjustment (Production/Consumption/Mixed) vouchers
        if (
          (voucher.voucherType === "Production" ||
            voucher.voucherType === "Consumption" ||
            voucher.voucherType === "Mixed") &&
          !voucher.optional
        ) {
          // Get the stock adjustment record
          const [adjustmentVoucher] = await tx
            .select()
            .from(stockAdjustmentVouchers)
            .where(eq(stockAdjustmentVouchers.voucherId, id))
            .limit(1);

          if (adjustmentVoucher) {
            // Get the adjustment items
            const adjustmentItemsList = await tx
              .select()
              .from(stockAdjustmentItems)
              .where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));

            // Reverse each item's inventory movement
            // Production forward logic: adds qty with weighted average
            // Consumption forward logic: subtracts qty, keeps rate
            // Mixed: depends on the individual item qty sign
            for (const item of adjustmentItemsList) {
              const qty = parseFloat(item.quantity);
              const adjustmentRate = parseFloat(item.rate);
              const absoluteQty = Math.abs(qty);

              // Same stored-casing hazard as the bulk path: see the note in
              // voucher-entries/bulk-delete.ts. A lowercase "production" row was
              // reversed the wrong way round, adding stock instead of removing it.
              const normalisedAdjustmentType = (adjustmentVoucher.adjustmentType || "").toLowerCase();
              const isProduction =
                normalisedAdjustmentType === "production" || (normalisedAdjustmentType === "mixed" && qty > 0);

              if (isProduction) {
                // Production added inventory, so reverse by subtracting
                const result = await adjustInventory(
                  tx,
                  adjustmentVoucher.locationId,
                  item.stockItemId,
                  -absoluteQty,
                  companyId
                );
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: String(absoluteQty),
                    unitCost: String(Math.max(adjustmentRate || result.averageRate || 0, 0)),
                    fromLocationId: adjustmentVoucher.locationId,
                    occurredAt,
                    source: {
                      sourceType: "voucher_delete_stock_adjustment",
                      sourceId: String(id),
                      idempotencyKey: `voucher-delete:adjustment:${companyId}:${id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete voucher ${voucher.voucherNumber}`,
                    },
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              } else {
                // Consumption subtracted inventory, so reverse by adding back
                await adjustInventory(
                  tx,
                  adjustmentVoucher.locationId,
                  item.stockItemId,
                  absoluteQty,
                  companyId,
                  adjustmentRate
                );
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: String(absoluteQty),
                    unitCost: String(Math.max(adjustmentRate || 0, 0)),
                    toLocationId: adjustmentVoucher.locationId,
                    occurredAt,
                    source: {
                      sourceType: "voucher_delete_stock_adjustment",
                      sourceId: String(id),
                      idempotencyKey: `voucher-delete:adjustment:${companyId}:${id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete voucher ${voucher.voucherNumber}`,
                    },
                  },
                  canonicalStockMovementAdapter
                );
              }
            }

            // Delete stock adjustment items
            await tx.delete(stockAdjustmentItems).where(eq(stockAdjustmentItems.adjustmentId, adjustmentVoucher.id));

            // Delete stock adjustment voucher record
            await tx.delete(stockAdjustmentVouchers).where(eq(stockAdjustmentVouchers.id, adjustmentVoucher.id));
          }
        }

        // IMPORTANT: Reverse inventory movements for POS Sales vouchers (Receipt type with sales items)
        // Also handle "Sales" voucher type for completeness
        // POS Sale forward logic: subtracts qty, keeps existing rate
        // Reversal: add back qty at existing rate
        if ((voucher.voucherType === "Receipt" || voucher.voucherType === "Sales") && !voucher.optional) {
          // Check if this is a POS sale by looking for sales items
          const saleItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, id));

          if (saleItems.length > 0) {
            logger.info(`[POS Delete] Voucher ${id}: Found ${saleItems.length} sale items to reverse`);

            // Only reverse inventory if we have a definite location from the voucher
            // We don't guess the location to avoid restoring stock to the wrong place
            if (voucher.locationId) {
              const targetLocationId = voucher.locationId;
              // This is a POS sale - add sold items back to inventory
              for (const item of saleItems) {
                const qty = parseFloat(item.quantity);
                const costPrice = parseFloat(item.costPrice || "0");

                logger.info(`[POS Delete] Restoring item ${item.stockItemId}: qty=${qty}, costPrice=${costPrice}`);

                const result = await adjustInventory(tx, targetLocationId, item.stockItemId, qty, companyId, costPrice);
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: String(qty),
                    unitCost: String(Math.max(costPrice || result.averageRate || 0, 0)),
                    toLocationId: targetLocationId,
                    occurredAt,
                    source: {
                      sourceType: "voucher_delete_pos_sale",
                      sourceId: String(id),
                      idempotencyKey: `voucher-delete:pos:${companyId}:${id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete voucher ${voucher.voucherNumber}`,
                    },
                  },
                  canonicalStockMovementAdapter
                );
                logger.info(
                  `[POS Delete] Item ${item.stockItemId}: qty ${result.previousQuantity} + ${qty} = ${result.newQuantity}, rate: ${result.averageRate.toFixed(2)}`
                );
              }
            } else {
              // Log warning: can't reverse inventory without location
              logger.warn(`[POS Delete] Voucher ${id}: Cannot reverse inventory - no locationId on voucher`);
            }

            // Delete sales items regardless of whether inventory was reversed
            logger.info(`[POS Delete] Deleting ${saleItems.length} sales items for voucher ${id}`);
            await tx.delete(salesItems).where(eq(salesItems.voucherId, id));
          }
        }

        // IMPORTANT: Reverse inventory movements for Credit Note / Debit Note vouchers
        if ((voucher.voucherType === "Credit Note" || voucher.voucherType === "Debit Note") && !voucher.optional) {
          // Get the credit note items
          const noteItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, id));

          if (noteItems.length > 0) {
            logger.info(`[Credit/Debit Note Delete] Voucher ${id}: Found ${noteItems.length} items to reverse`);

            for (const item of noteItems) {
              const qty = parseFloat(item.quantity);
              const inventoryCost = parseFloat(item.inventoryCost || item.rate || "0");

              if (voucher.voucherType === "Credit Note") {
                // Credit Note forward: added qty to inventory
                // Reversal: subtract qty from inventory
                const result = await adjustInventory(tx, item.locationId, item.stockItemId, -qty, companyId);
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: String(qty),
                    unitCost: String(Math.max(inventoryCost || result.averageRate || 0, 0)),
                    fromLocationId: item.locationId,
                    occurredAt,
                    source: {
                      sourceType: "voucher_delete_credit_note",
                      sourceId: String(id),
                      idempotencyKey: `voucher-delete:credit-note:${companyId}:${id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete voucher ${voucher.voucherNumber}`,
                    },
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
                logger.info(
                  `[Credit Note Delete] Item ${item.stockItemId} at location ${item.locationId}: qty ${result.previousQuantity} - ${qty} = ${result.newQuantity}`
                );
              } else {
                // Debit Note forward: removed qty from inventory
                // Reversal: add qty back to inventory
                const result = await adjustInventory(
                  tx,
                  item.locationId,
                  item.stockItemId,
                  qty,
                  companyId,
                  inventoryCost
                );
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: item.stockItemId,
                    kind: "adjustment",
                    quantity: String(qty),
                    unitCost: String(Math.max(inventoryCost || result.averageRate || 0, 0)),
                    toLocationId: item.locationId,
                    occurredAt,
                    source: {
                      sourceType: "voucher_delete_debit_note",
                      sourceId: String(id),
                      idempotencyKey: `voucher-delete:debit-note:${companyId}:${id}:${item.id}`,
                    },
                    actor: {
                      userId: req.session.userId,
                      username: req.session.username,
                      reason: `Delete voucher ${voucher.voucherNumber}`,
                    },
                  },
                  canonicalStockMovementAdapter
                );
                logger.info(
                  `[Debit Note Delete] Item ${item.stockItemId} at location ${item.locationId}: qty ${result.previousQuantity} + ${qty} = ${result.newQuantity}`
                );
              }
            }

            // Delete the credit note items
            logger.info(`[Credit/Debit Note Delete] Deleting ${noteItems.length} credit_note_items for voucher ${id}`);
            await tx.delete(creditNoteItems).where(eq(creditNoteItems.voucherId, id));
          }
        }

        if (!voucher.optional) {
          const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, id));

          // Reverse the entries' effect on employee balances
          await syncEmployeeBalancesFromEntries(
            entries.map((e) => ({
              ledgerAccountId: e.ledgerAccountId,
              employeeId: e.employeeId,
              debitAmount: e.debitAmount,
              creditAmount: e.creditAmount,
            })),
            companyId,
            true // reverse
          );
        }

        // IMPORTANT: If this voucher is linked to a property payment entry,
        // reverse the monthly ledger and delete the payment log row so the
        // rent balance and payment history stay consistent.
        const linkedPayments = await tx.select().from(propertyPayments).where(eq(propertyPayments.voucherId, id));
        for (const pmt of linkedPayments) {
          if (pmt.ledgerRowId) {
            await tx.execute(sql`
                UPDATE property_monthly_ledger
                SET paid_amount = GREATEST(0, paid_amount - ${pmt.amount}::numeric)
                WHERE id = ${pmt.ledgerRowId}
              `);
          }
          await tx.delete(propertyPayments).where(eq(propertyPayments.id, pmt.id));
        }

        // IMPORTANT: If this voucher is one side of an inter-company transfer,
        // also delete the OTHER side's entries + voucher and the transfer record.
        // Delete the transfer record FIRST to release the FK "restrict" constraints
        // on fromVoucherId / toVoucherId before hard-deleting those voucher rows.
        const linkedTransfersSingle = await tx
          .select()
          .from(interCompanyTransfers)
          .where(or(eq(interCompanyTransfers.fromVoucherId, id), eq(interCompanyTransfers.toVoucherId, id)));
        for (const transfer of linkedTransfersSingle) {
          const otherVoucherId = transfer.fromVoucherId === id ? transfer.toVoucherId : transfer.fromVoucherId;
          await tx.delete(interCompanyTransfers).where(eq(interCompanyTransfers.id, transfer.id));
          if (otherVoucherId && otherVoucherId !== id) {
            await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otherVoucherId));
            await tx.delete(vouchers).where(eq(vouchers.id, otherVoucherId));
          }
        }

        // Clean up any pending IC notification requests for this voucher
        // so recipients stop seeing the bell notification for a deleted payment.
        await tx
          .delete(intercompanyPaymentRequests)
          .where(
            and(eq(intercompanyPaymentRequests.fromVoucherId, id), eq(intercompanyPaymentRequests.status, "pending"))
          );

        // Soft delete: Keep voucher entries but set deletedAt on voucher
        // This automatically excludes entries from balance calculations
        // (calculateAccountBalance filters by isNull(vouchers.deletedAt))
        await tx.update(vouchers).set({ deletedAt: new Date() }).where(eq(vouchers.id, id));
      });

      // Log the deletion to audit log (entries are soft-deleted so still fetchable)
      const _delEntries = await storage.getVoucherEntriesByVoucher(id).catch(() => []);
      const _delEntriesSnap = await snapshotVoucherEntries(_delEntries).catch(() => []);
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId,
        action: "delete",
        tableName: "vouchers",
        recordId: id,
        recordIdentifier: voucher.voucherNumber,
        changes: buildVoucherChangesForDelete(voucher, _delEntriesSnap),
      });

      res.json({ message: "Voucher deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
