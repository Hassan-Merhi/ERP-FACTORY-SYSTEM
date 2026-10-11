/**
 * adminRepairRoutes: AdminRepairMisc endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { db } from "../../../db";
import { requireAuth, requireRole, requireNonPOS } from "../../../auth";
import { stockTransferVouchers, stockTransferItems, vouchers } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { writeAuditEvent } from "../../../services/audit";
import {
  assertStoredVoucherLinesValidTx,
  replacementErrorStatus,
} from "../../../services/accounting/voucherEntryReplacement";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerAdminRepairMiscRoutes(app: Express) {
  // Finalizing activates a voucher, so it is an Admin/Owner action that must leave
  // the voucher's stored lines valid for an active voucher, and is audited
  // (wave 9 ledger safety: it used to be open to every non-POS role, unchecked).
  app.post(
    "/api/vouchers/:id/finalize",
    requireAuth,
    requireNonPOS,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId || req.session.factoryCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const voucherId = parseInt(req.params.id);
        if (isNaN(voucherId)) return res.status(400).json({ message: "Invalid voucher ID" });

        const [voucher] = await db
          .select()
          .from(vouchers)
          .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)));

        if (!voucher) return res.status(404).json({ message: "Voucher not found" });
        const blockedVoucherReason = voucherMutationBlockReason(voucher);
        if (blockedVoucherReason) {
          return res.status(403).json({ message: blockedVoucherReason });
        }
        if (!voucher.optional) return res.status(400).json({ message: "Voucher is already finalized" });

        // Refused before any side effect when the lines do not satisfy the
        // active-voucher rules for the type (a balanced type must balance exactly).
        try {
          await assertStoredVoucherLinesValidTx(db, { ...voucher, optional: false });
        } catch (validationError: unknown) {
          const status = replacementErrorStatus(validationError);
          if (status) return res.status(status).json({ message: getErrorMessage(validationError) });
          throw validationError;
        }

        // For stock transfers: apply inventory changes on finalization
        const updated = await db.transaction(async (tx) => {
          if (voucher.voucherType === "Stock Transfer" || voucher.voucherType === "StockTransfer") {
            const [transferRecord] = await tx
              .select()
              .from(stockTransferVouchers)
              .where(eq(stockTransferVouchers.voucherId, voucherId));

            if (transferRecord) {
              const items = await tx
                .select()
                .from(stockTransferItems)
                .where(eq(stockTransferItems.transferId, transferRecord.id));

              const occurredAt = new Date().toISOString();
              for (const item of items) {
                const srcId = item.sourceLocationId || transferRecord.sourceLocationId;
                const qty = parseFloat(item.quantity);
                const rate = parseFloat(item.rate || "0");
                if (srcId && qty > 0) {
                  await adjustInventory(tx, srcId, item.stockItemId, -qty, companyId);
                  await adjustInventory(
                    tx,
                    transferRecord.destinationLocationId,
                    item.stockItemId,
                    qty,
                    companyId,
                    rate
                  );
                  await postStockMovementTx(
                    tx,
                    {
                      companyId,
                      stockItemId: item.stockItemId,
                      kind: "transfer",
                      quantity: String(qty),
                      unitCost: String(Math.max(rate || 0, 0)),
                      fromLocationId: srcId,
                      toLocationId: transferRecord.destinationLocationId,
                      occurredAt,
                      source: {
                        sourceType: "voucher_finalize_stock_transfer",
                        sourceId: String(voucherId),
                        idempotencyKey: `voucher-finalize-transfer:${companyId}:${voucherId}:${item.id}`,
                      },
                      actor: {
                        userId: req.session.userId,
                        username: req.session.username,
                        reason: `Finalize ${voucher.voucherNumber}`,
                      },
                      allowNegativeStock: true,
                    },
                    canonicalStockMovementAdapter
                  );
                }
              }

              await tx
                .update(stockTransferVouchers)
                .set({ inventoryApplied: true })
                .where(eq(stockTransferVouchers.id, transferRecord.id));
            }
          }

          const [updated] = await tx
            .update(vouchers)
            .set({ optional: false })
            .where(eq(vouchers.id, voucherId))
            .returning();
          await writeAuditEvent(
            {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "vouchers",
              recordId: voucherId,
              recordIdentifier: voucher.voucherNumber,
              changes: { optional: { old: true, new: false } },
            },
            tx
          );
          return updated;
        });

        res.json(updated);
      } catch (error: unknown) {
        logger.error("Finalize voucher error:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  app.post("/api/dev/seed", requireAuth, requireRole("Admin"), async (req, res) => {
    if (process.env.NODE_ENV !== "development") {
      return res.status(403).json({ message: "Dev seed only available in development" });
    }
    try {
      const { runDevSeed } = await import("../../../seedDev");
      const summary = await runDevSeed();
      logger.info("\n=== SEED DATA SUMMARY ===");
      logger.info(`Products: ${summary.products}`);
      logger.info(`Bales: ${summary.bales}`);
      logger.info(`Label Prints: ${summary.labelPrints} (${summary.scannedLabels} scanned)`);
      logger.info(`\nSample ARTICLE codes: ${summary.sampleArticleCodes.join(", ")}`);
      logger.info(`Sample REFERENCE numbers: ${summary.sampleReferenceNumbers.join(", ")}`);
      logger.info("========================\n");
      res.json(summary);
    } catch (error: unknown) {
      logger.error("Seed error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ==========================================
  // ERP User Page Access
  // ==========================================
}
