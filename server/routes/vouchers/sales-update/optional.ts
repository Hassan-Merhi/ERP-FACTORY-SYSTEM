/**
 * voucherSalesUpdateRoutes: VoucherOptionalUpdate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { logAudit, syncEmployeeBalancesFromEntries } from "../../_helpers";
import {
  stockTransferVouchers,
  stockTransferItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
  vouchers,
  salesItems,
  creditNoteItems,
} from "@shared/schema";
import { eq } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { nextCanonicalSourceRevision } from "../../../services/inventory/canonicalSourceRevision";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerVoucherOptionalUpdateRoutes(app: Express) {
  // Toggle optional status for a voucher
  app.patch("/api/vouchers/:id/optional", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid voucher ID" });
      }

      const { optional } = req.body;
      if (typeof optional !== "boolean") {
        return res.status(400).json({ message: "Optional must be a boolean value" });
      }

      // Get the existing voucher to check company and permissions
      const existingVoucher = await storage.getVoucherById(id);
      if (!existingVoucher) {
        return res.status(404).json({ message: "Voucher not found" });
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

      // Only Admin and Owner can toggle optional status
      const userRole = req.session.currentRole;
      if (userRole !== "Admin" && userRole !== "Owner" && userRole !== "Developer") {
        return res.status(403).json({
          message: "Only Admin and Owner can toggle optional status",
        });
      }

      const wasOptional = existingVoucher.optional;
      const willBeOptional = optional;

      // Wrap entire optional toggle in a transaction
      await db.transaction(async (tx) => {
        // Check if there are stock operations linked to this voucher
        const hasStockTransfer = await tx
          .select()
          .from(stockTransferVouchers)
          .where(eq(stockTransferVouchers.voucherId, id))
          .limit(1);

        const hasStockAdjustment = await tx
          .select()
          .from(stockAdjustmentVouchers)
          .where(eq(stockAdjustmentVouchers.voucherId, id))
          .limit(1);

        // Handle inventory changes when toggling optional status
        // If changing from false→true: reverse inventory changes
        // If changing from true→false: apply inventory changes
        if (wasOptional !== willBeOptional) {
          const evidenceRevision = await nextCanonicalSourceRevision(
            tx,
            existingVoucher.companyId,
            "voucher-optional-toggle",
            String(id)
          );
          const occurredAt = new Date().toISOString();
          const evidenceActor = {
            userId: req.session.userId,
            username: req.session.username,
            reason: `${willBeOptional ? "Suspend" : "Activate"} voucher ${existingVoucher.voucherNumber}`,
          };

          if (hasStockTransfer.length > 0) {
            const transfer = hasStockTransfer[0];
            const items = await tx
              .select()
              .from(stockTransferItems)
              .where(eq(stockTransferItems.transferId, transfer.id));

            for (const item of items) {
              const sourceLocId = item.sourceLocationId ?? transfer.sourceLocationId;
              const destinationLocId = transfer.destinationLocationId;
              if (sourceLocId == null || destinationLocId == null) {
                throw new Error("Stock transfer is missing source or destination location");
              }
              const quantity = parseFloat(item.quantity);
              const rate = parseFloat(item.rate);

              // Guard on inventoryApplied: only reverse if inventory was actually applied,
              // only apply if inventory was not already applied. Prevents stock corruption
              // from double-toggling or legacy transfers with mismatched flag states.
              if (willBeOptional && transfer.inventoryApplied) {
                // Reverse: inventory was applied, now marking optional → undo it
                await adjustInventory(tx, sourceLocId, item.stockItemId, quantity, existingVoucher.companyId, rate);
                await adjustInventory(tx, destinationLocId, item.stockItemId, -quantity, existingVoucher.companyId);
                await postStockMovementTx(
                  tx,
                  {
                    companyId: existingVoucher.companyId,
                    stockItemId: item.stockItemId,
                    kind: "transfer",
                    quantity: String(quantity),
                    unitCost: String(Math.max(rate || 0, 0)),
                    fromLocationId: destinationLocId,
                    toLocationId: sourceLocId,
                    occurredAt,
                    source: {
                      sourceType: "voucher-optional-toggle-transfer-reverse",
                      sourceId: String(id),
                      idempotencyKey: `voucher-optional:rev${evidenceRevision}:transfer-reverse:${item.id}`,
                    },
                    actor: evidenceActor,
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              } else if (!willBeOptional && !transfer.inventoryApplied) {
                // Apply: inventory was not applied, now marking non-optional → apply it
                await adjustInventory(tx, sourceLocId, item.stockItemId, -quantity, existingVoucher.companyId);
                await adjustInventory(
                  tx,
                  destinationLocId,
                  item.stockItemId,
                  quantity,
                  existingVoucher.companyId,
                  rate
                );
                await postStockMovementTx(
                  tx,
                  {
                    companyId: existingVoucher.companyId,
                    stockItemId: item.stockItemId,
                    kind: "transfer",
                    quantity: String(quantity),
                    unitCost: String(Math.max(rate || 0, 0)),
                    fromLocationId: sourceLocId,
                    toLocationId: destinationLocId,
                    occurredAt,
                    source: {
                      sourceType: "voucher-optional-toggle-transfer-apply",
                      sourceId: String(id),
                      idempotencyKey: `voucher-optional:rev${evidenceRevision}:transfer-apply:${item.id}`,
                    },
                    actor: evidenceActor,
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              }
              // else: already in the correct applied/unapplied state — no-op
            }

            // CRITICAL: sync inventoryApplied on the transfer record so that
            // a subsequent updateStockTransfer call knows the correct state and
            // does not double-apply or double-reverse inventory.
            await tx
              .update(stockTransferVouchers)
              .set({ inventoryApplied: !willBeOptional })
              .where(eq(stockTransferVouchers.id, transfer.id));
          }

          if (hasStockAdjustment.length > 0) {
            const adjustment = hasStockAdjustment[0];
            const items = await tx
              .select()
              .from(stockAdjustmentItems)
              .where(eq(stockAdjustmentItems.adjustmentId, adjustment.id));

            for (const item of items) {
              const rawQuantity = parseFloat(item.quantity);
              const quantity = Math.abs(rawQuantity);
              const rate = parseFloat(item.rate);

              // For Mixed adjustments, check the item's quantity sign:
              //   - Positive quantity = production (added)
              //   - Negative quantity = consumption (subtracted)
              const adjustmentType = adjustment.adjustmentType;
              const isProduction = adjustmentType === "Production" || (adjustmentType === "Mixed" && rawQuantity > 0);

              let outgoing = false;
              if (willBeOptional) {
                // Reversing the adjustment
                if (isProduction) {
                  // Reverse production: subtract what was added
                  await adjustInventory(
                    tx,
                    adjustment.locationId,
                    item.stockItemId,
                    -quantity,
                    existingVoucher.companyId
                  );
                  outgoing = true;
                } else {
                  // Reverse consumption: add back what was subtracted
                  await adjustInventory(
                    tx,
                    adjustment.locationId,
                    item.stockItemId,
                    quantity,
                    existingVoucher.companyId,
                    rate
                  );
                }
              } else {
                // Applying the adjustment
                if (isProduction) {
                  // Apply production: add to inventory
                  await adjustInventory(
                    tx,
                    adjustment.locationId,
                    item.stockItemId,
                    quantity,
                    existingVoucher.companyId,
                    rate
                  );
                } else {
                  // Apply consumption: subtract from inventory
                  await adjustInventory(
                    tx,
                    adjustment.locationId,
                    item.stockItemId,
                    -quantity,
                    existingVoucher.companyId
                  );
                  outgoing = true;
                }
              }
              await postStockMovementTx(
                tx,
                {
                  companyId: existingVoucher.companyId,
                  stockItemId: item.stockItemId,
                  kind: "adjustment",
                  quantity: String(quantity),
                  unitCost: String(Math.max(rate || 0, 0)),
                  fromLocationId: outgoing ? adjustment.locationId : undefined,
                  toLocationId: outgoing ? undefined : adjustment.locationId,
                  occurredAt,
                  source: {
                    sourceType: "voucher-optional-toggle-adjustment",
                    sourceId: String(id),
                    idempotencyKey: `voucher-optional:rev${evidenceRevision}:adjustment:${item.id}`,
                  },
                  actor: evidenceActor,
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }

          // Handle Sales items inventory when toggling optional
          const hasSalesItems = await tx.select().from(salesItems).where(eq(salesItems.voucherId, id));

          if (hasSalesItems.length > 0 && existingVoucher.locationId) {
            for (const item of hasSalesItems) {
              const quantity = parseFloat(item.quantity);
              const costPrice = parseFloat(item.costPrice);
              if (willBeOptional) {
                // Reverse: add back stock that was deducted by the sale
                await adjustInventory(
                  tx,
                  existingVoucher.locationId,
                  item.stockItemId,
                  quantity,
                  existingVoucher.companyId,
                  costPrice
                );
              } else {
                // Apply: deduct stock for the sale
                await adjustInventory(
                  tx,
                  existingVoucher.locationId,
                  item.stockItemId,
                  -quantity,
                  existingVoucher.companyId
                );
              }
              await postStockMovementTx(
                tx,
                {
                  companyId: existingVoucher.companyId,
                  stockItemId: item.stockItemId,
                  kind: "adjustment",
                  quantity: String(quantity),
                  unitCost: String(Math.max(costPrice || 0, 0)),
                  fromLocationId: willBeOptional ? undefined : existingVoucher.locationId,
                  toLocationId: willBeOptional ? existingVoucher.locationId : undefined,
                  occurredAt,
                  source: {
                    sourceType: "voucher-optional-toggle-sale",
                    sourceId: String(id),
                    idempotencyKey: `voucher-optional:rev${evidenceRevision}:sale:${item.id}`,
                  },
                  actor: evidenceActor,
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }

          // Handle Credit Note items inventory when toggling optional
          const hasCreditNoteItems = await tx.select().from(creditNoteItems).where(eq(creditNoteItems.voucherId, id));

          if (hasCreditNoteItems.length > 0) {
            for (const item of hasCreditNoteItems) {
              const quantity = parseFloat(item.quantity);
              const rate = parseFloat(item.rate);
              if (willBeOptional) {
                // Reverse: remove stock that was added by the credit note (customer return)
                await adjustInventory(tx, item.locationId, item.stockItemId, -quantity, existingVoucher.companyId);
              } else {
                // Apply: add stock back for the credit note (customer return)
                await adjustInventory(tx, item.locationId, item.stockItemId, quantity, existingVoucher.companyId, rate);
              }
              await postStockMovementTx(
                tx,
                {
                  companyId: existingVoucher.companyId,
                  stockItemId: item.stockItemId,
                  kind: "adjustment",
                  quantity: String(quantity),
                  unitCost: String(Math.max(rate || 0, 0)),
                  fromLocationId: willBeOptional ? item.locationId : undefined,
                  toLocationId: willBeOptional ? undefined : item.locationId,
                  occurredAt,
                  source: {
                    sourceType: "voucher-optional-toggle-credit-note",
                    sourceId: String(id),
                    idempotencyKey: `voucher-optional:rev${evidenceRevision}:credit-note:${item.id}`,
                  },
                  actor: evidenceActor,
                  allowNegativeStock: true,
                },
                canonicalStockMovementAdapter
              );
            }
          }
        }

        // Update the optional field inside transaction
        await tx.update(vouchers).set({ optional }).where(eq(vouchers.id, id));
      });
      // Log the optional status change to audit log
      await logAudit({
        userId: req.session.userId!,
        username: req.session.username || "unknown",
        companyId: req.session.currentCompanyId!,
        action: "update",
        tableName: "vouchers",
        recordId: id,
        recordIdentifier: existingVoucher.voucherNumber,
        changes: { optional: { old: wasOptional, new: willBeOptional } },
      });

      // Sync employee balances when optional status changes
      if (wasOptional !== willBeOptional && req.session.currentCompanyId) {
        const entries = await storage.getVoucherEntriesByVoucher(id);
        if (willBeOptional) {
          // Voucher is becoming optional - reverse entries' effects
          await syncEmployeeBalancesFromEntries(
            entries.map((e) => ({
              ledgerAccountId: e.ledgerAccountId,
              employeeId: e.employeeId,
              debitAmount: e.debitAmount,
              creditAmount: e.creditAmount,
            })),
            req.session.currentCompanyId,
            true // reverse
          );
        } else {
          // Voucher is becoming active - apply entries' effects
          await syncEmployeeBalancesFromEntries(
            entries.map((e) => ({
              ledgerAccountId: e.ledgerAccountId,
              employeeId: e.employeeId,
              debitAmount: e.debitAmount,
              creditAmount: e.creditAmount,
            })),
            req.session.currentCompanyId
          );
        }
      }

      // Fetch updated voucher outside transaction
      const updated = await storage.getVoucherById(id);
      res.json(updated);
    } catch (error: unknown) {
      if ((error as { name?: string }).name === "ValidationError") {
        return res.status(400).json({ message: getErrorMessage(error) });
      }
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
