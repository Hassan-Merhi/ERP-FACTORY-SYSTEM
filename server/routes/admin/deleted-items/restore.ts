/**
 * deletedItemsRoutes: DeletedItemsRestore endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { toMoney } from "../../../lib/money";
import { voucherMutationBlockReason } from "../../../lib/migratedVoucherGuard";
import { writeAuditEvent } from "../../../services/audit";
import { firstRow } from "../../../lib/queryResult";
import { PRIORITY_SCAN_LOCK_NAMESPACE } from "../../factory/customer-orders/priorityScanQueue";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryContainers,
  factoryRawStock,
  factoryRawMaterialAdjustments,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryBales,
  customerProformas,
  customerOrders,
  stockItems,
  stockGroups,
  bankAccounts,
  vouchers,
  voucherEntries,
  customers,
  locations,
  employees,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, sql, isNotNull } from "drizzle-orm";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { syncPurchaseOrderGitForVoucherTx } from "../../../services/accounting/perpetualInventory/stockReceipts";
import { syncStockAdjustmentInventoryTx } from "../../../services/accounting/perpetualInventory/stockAdjustments";
import { syncFactoryInvoiceForChargeVoucherTx } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import {
  isUnrestorableStockDocumentTx,
  STOCK_DOCUMENT_NOT_RESTORABLE,
  STOCK_DOCUMENT_NOT_RESTORABLE_MESSAGE,
} from "../../../services/inventory/voucherStockReversal";
import { syncContainerCommissionJournalTx } from "../../../services/factory/containerCommissionJournal";
import {
  isRetiredVoucherNumber,
  RETIRED_VOUCHER_NOT_RESTORABLE,
  RETIRED_VOUCHER_NOT_RESTORABLE_MESSAGE,
} from "../../../services/accounting/voucherRetirement";

/**
 * Wave 9 (ledger safety): restoring a voucher puts it back into every balance,
 * so it is an Admin/Owner action (Developer passes, as with requireRole). The
 * other item types keep the route-level non-POS rule.
 */
const VOUCHER_RESTORE_ROLES = new Set(["Admin", "Owner", "Developer"]);

export function registerDeletedItemsRestoreRoutes(app: Express) {
  // Restore a deleted item
  app.post("/api/deleted-items/:type/:id/restore", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const { type, id } = req.params;
      const itemId = parseInt(id);
      if (isNaN(itemId)) {
        return res.status(400).json({ message: "Invalid item ID" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      switch (type) {
        case "location":
          await db
            .update(locations)
            .set({ deletedAt: null, active: true })
            .where(and(eq(locations.id, itemId), eq(locations.companyId, companyId)));
          break;
        case "stockItem":
          await db
            .update(stockItems)
            .set({ deletedAt: null, active: true })
            .where(and(eq(stockItems.id, itemId), eq(stockItems.companyId, companyId)));
          break;
        case "stockGroup":
          await db
            .update(stockGroups)
            .set({ deletedAt: null, active: true })
            .where(and(eq(stockGroups.id, itemId), eq(stockGroups.companyId, companyId)));
          break;
        case "ledgerAccount":
          await db
            .update(ledgerAccounts)
            .set({ deletedAt: null, active: true })
            .where(and(eq(ledgerAccounts.id, itemId), eq(ledgerAccounts.companyId, companyId)));
          break;
        case "employee":
          await db
            .update(employees)
            .set({ deletedAt: null, active: true })
            .where(and(eq(employees.id, itemId), eq(employees.companyId, companyId)));
          break;
        case "customer":
          await db
            .update(customers)
            .set({ deletedAt: null, active: true })
            .where(and(eq(customers.id, itemId), eq(customers.companyId, companyId)));
          break;
        case "supplier":
          // Wave 18 (B): the active company's supplier only.
          await db
            .update(companyScopedSuppliers)
            .set({ deletedAt: null, active: true })
            .where(and(eq(companyScopedSuppliers.id, itemId), eq(companyScopedSuppliers.companyId, companyId)));
          break;
        case "bankAccount":
          await db
            .update(bankAccounts)
            .set({ deletedAt: null, active: true })
            .where(and(eq(bankAccounts.id, itemId), eq(bankAccounts.companyId, companyId)));
          break;
        case "voucher": {
          if (!VOUCHER_RESTORE_ROLES.has(req.user?.role ?? "")) {
            return res.status(403).json({ message: "Forbidden" });
          }
          const [voucher] = await db
            .select()
            .from(vouchers)
            .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId), isNotNull(vouchers.deletedAt)));
          if (!voucher) {
            return res.status(404).json({ message: `${type} not found in Deleted Items` });
          }
          // Wave 16 (A): a voucher the system retired when its source posted a
          // replacement is not restorable: the replacement is live.
          if (isRetiredVoucherNumber(voucher.voucherNumber)) {
            return res
              .status(409)
              .json({ code: RETIRED_VOUCHER_NOT_RESTORABLE, message: RETIRED_VOUCHER_NOT_RESTORABLE_MESSAGE });
          }
          const blockedVoucherReason = voucherMutationBlockReason(voucher);
          if (blockedVoucherReason) {
            return res.status(403).json({ message: blockedVoucherReason });
          }
          // The closed-period trigger refuses clearing deleted_at on a voucher
          // dated inside closed books; that error rolls this back and answers 409.
          let notRestorable = false;
          await db.transaction(async (tx) => {
            // Wave 15 (C2): a stock document whose delete reversed and removed
            // its stock lines is not restorable (voucherStockReversal.ts).
            if (await isUnrestorableStockDocumentTx(tx, companyId, voucher)) {
              notRestorable = true;
              return;
            }
            await tx
              .update(vouchers)
              .set({ deletedAt: null })
              .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));
            // Perpetual inventory (wave 8.2): a restored PO voucher is in transit again.
            await syncPurchaseOrderGitForVoucherTx(tx, companyId, itemId);
            // Perpetual inventory (wave 8.3): a restored stock adjustment carries its inventory line again.
            await syncStockAdjustmentInventoryTx(tx, companyId, itemId);
            // Perpetual inventory (wave 8.4): an order whose charge this voucher carries re-syncs its invoice journal.
            await syncFactoryInvoiceForChargeVoucherTx(tx, companyId, itemId);
            const entries = await tx
              .select({
                ledgerAccountId: voucherEntries.ledgerAccountId,
                bankAccountId: voucherEntries.bankAccountId,
                supplierId: voucherEntries.supplierId,
                customerId: voucherEntries.customerId,
                employeeId: voucherEntries.employeeId,
                debitAmount: voucherEntries.debitAmount,
                creditAmount: voucherEntries.creditAmount,
              })
              .from(voucherEntries)
              .where(eq(voucherEntries.voucherId, itemId));
            await writeAuditEvent(
              {
                userId: req.session.userId ?? "unknown",
                username: req.session.username || "unknown",
                companyId,
                action: "restore",
                tableName: "vouchers",
                recordId: itemId,
                recordIdentifier: voucher.voucherNumber,
                changes: {
                  deletedAt: { old: voucher.deletedAt, new: null },
                  voucherType: { new: voucher.voucherType },
                  date: { new: voucher.voucherDate },
                  amount: { new: voucher.totalAmount },
                  entries: { new: entries },
                },
              },
              tx
            );
          });
          if (notRestorable) {
            return res
              .status(409)
              .json({ code: STOCK_DOCUMENT_NOT_RESTORABLE, message: STOCK_DOCUMENT_NOT_RESTORABLE_MESSAGE });
          }
          break;
        }
        // === Wave 1 restores ===
        case "factoryCategory":
          await db
            .update(factoryCategories)
            .set({ deletedAt: null, isActive: true, updatedAt: new Date() })
            .where(and(eq(factoryCategories.id, itemId), eq(factoryCategories.companyId, companyId)));
          break;
        case "factoryBaleProduct":
          await db
            .update(factoryBaleProducts)
            .set({ deletedAt: null, active: true, updatedAt: new Date() })
            .where(and(eq(factoryBaleProducts.id, itemId), eq(factoryBaleProducts.companyId, companyId)));
          break;
        case "factoryContainer":
          await db
            .update(factoryContainers)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(and(eq(factoryContainers.id, itemId), eq(factoryContainers.companyId, companyId)));
          break;
        case "factoryRawStock":
          // Wave 14: a commission held on the row comes back into the ledger
          // (FACTORY-COMM-{container}) in the same transaction.
          await db.transaction(async (tx) => {
            const [restored] = await tx
              .update(factoryRawStock)
              .set({ deletedAt: null })
              .where(and(eq(factoryRawStock.id, itemId), eq(factoryRawStock.companyId, companyId)))
              .returning({ containerId: factoryRawStock.containerId, commission: factoryRawStock.commissionAmount });
            if (restored && !toMoney(restored.commission ?? 0).isZero()) {
              await syncContainerCommissionJournalTx(tx, companyId, restored.containerId);
            }
          });
          break;
        case "factoryRawMaterialAdjustment":
          await db
            .update(factoryRawMaterialAdjustments)
            .set({ deletedAt: null })
            .where(
              and(eq(factoryRawMaterialAdjustments.id, itemId), eq(factoryRawMaterialAdjustments.companyId, companyId))
            );
          break;
        case "factoryMixBatch":
          // Restoring must re-apply the usedKg consumption on its sources — the
          // DELETE route (factoryMixBatchRoutes.ts) reverses that consumption on
          // delete, so skipping it here would leave the source stock artificially
          // over-available (double-counted as both free and locked in this batch).
          await db.transaction(async (tx) => {
            // Guard: only restore rows that are actually soft-deleted, so calling
            // restore twice (or on an already-active batch) can't re-apply
            // consumption a second time.
            const [restored] = await tx
              .update(factoryMixBatches)
              .set({ deletedAt: null, updatedAt: new Date() })
              .where(
                and(
                  eq(factoryMixBatches.id, itemId),
                  eq(factoryMixBatches.companyId, companyId),
                  isNotNull(factoryMixBatches.deletedAt)
                )
              )
              .returning({ id: factoryMixBatches.id });
            if (!restored) return;

            const batchSourceRows = await tx
              .select({
                containerId: factoryMixBatchSources.containerId,
                sourceBatchId: factoryMixBatchSources.sourceBatchId,
                weightKg: factoryMixBatchSources.weightKg,
              })
              .from(factoryMixBatchSources)
              .where(eq(factoryMixBatchSources.mixBatchId, itemId));

            for (const src of batchSourceRows) {
              const weight = parseFloat(src.weightKg) || 0;
              if (weight <= 0) continue;
              if (src.containerId) {
                // Scope to companyId too (via a join-equivalent subselect) so a
                // corrupted/cross-tenant containerId can never mutate another
                // company's raw stock.
                await tx
                  .update(factoryRawStock)
                  .set({ usedKg: sql`${factoryRawStock.usedKg} + ${weight}` })
                  .where(
                    and(eq(factoryRawStock.containerId, src.containerId), eq(factoryRawStock.companyId, companyId))
                  );
              } else if (src.sourceBatchId) {
                await tx
                  .update(factoryMixBatches)
                  .set({ usedKg: sql`${factoryMixBatches.usedKg} + ${weight}`, updatedAt: new Date() })
                  .where(and(eq(factoryMixBatches.id, src.sourceBatchId), eq(factoryMixBatches.companyId, companyId)));
              }
            }
          });
          break;
        case "factoryBale": {
          const result = await db.transaction(async (tx) => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
            const [bale] = await tx
              .select({
                id: factoryBales.id,
                deletedAt: factoryBales.deletedAt,
              })
              .from(factoryBales)
              .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, itemId)))
              .limit(1);
            if (!bale) return "missing";
            if (!bale.deletedAt) return "already-active";

            // Physical stock removals have already debited ERP inventory and
            // appended canonical journal evidence. Simply clearing deletedAt
            // would create a bale without inventory. It needs a controlled
            // re-entry with a new receipt and audit workflow instead.
            const removal =
              firstRow(
                await tx.execute(sql`
              SELECT id FROM factory_physical_bale_deletions
               WHERE company_id = ${companyId} AND bale_id = ${itemId}
               LIMIT 1
            `)
              ) ||
              firstRow(
                await tx.execute(sql`
              SELECT id FROM canonical_stock_movements
               WHERE company_id = ${companyId}
                 AND source_type = 'factory_bale_removal'
                 AND source_id = ${String(itemId)}
               LIMIT 1
            `)
              );
            if (removal) return "requires-reentry";
            await tx
              .update(factoryBales)
              .set({ deletedAt: null, status: "IN_STOCK", updatedAt: new Date() })
              .where(and(eq(factoryBales.id, itemId), eq(factoryBales.companyId, companyId)));
            return "restored";
          });
          if (result === "missing") return res.status(404).json({ message: "Bale not found" });
          if (result === "already-active") return res.status(409).json({ message: "Bale is not deleted" });
          if (result === "requires-reentry") {
            return res.status(409).json({
              message:
                "This bale has a recorded physical deletion. Use a controlled stock re-entry; restoring its status alone would create phantom inventory or undo the deletion audit.",
            });
          }
          break;
        }
        case "customerProforma":
          await db
            .update(customerProformas)
            .set({ deletedAt: null, isActive: true, updatedAt: new Date() })
            .where(and(eq(customerProformas.id, itemId), eq(customerProformas.companyId, companyId)));
          break;
        case "customerOrder":
          await db
            .update(customerOrders)
            .set({ deletedAt: null, updatedAt: new Date() })
            .where(and(eq(customerOrders.id, itemId), eq(customerOrders.companyId, companyId)));
          break;
        default:
          return res.status(400).json({ message: "Invalid item type" });
      }

      res.json({ message: `${type} restored successfully` });
    } catch (error: unknown) {
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });
}
