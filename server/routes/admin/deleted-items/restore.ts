/**
 * deletedItemsRoutes: DeletedItemsRestore endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
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
  suppliers,
  customers,
  locations,
  employees,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, sql, isNotNull } from "drizzle-orm";

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
          await db.update(suppliers).set({ deletedAt: null, active: true }).where(eq(suppliers.id, itemId));
          break;
        case "bankAccount":
          await db
            .update(bankAccounts)
            .set({ deletedAt: null, active: true })
            .where(and(eq(bankAccounts.id, itemId), eq(bankAccounts.companyId, companyId)));
          break;
        case "voucher":
          await db
            .update(vouchers)
            .set({ deletedAt: null })
            .where(and(eq(vouchers.id, itemId), eq(vouchers.companyId, companyId)));
          break;
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
          await db
            .update(factoryRawStock)
            .set({ deletedAt: null })
            .where(and(eq(factoryRawStock.id, itemId), eq(factoryRawStock.companyId, companyId)));
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
          const result = await db.transaction(async tx => {
            await tx.execute(sql`SELECT pg_advisory_xact_lock(${PRIORITY_SCAN_LOCK_NAMESPACE}, ${companyId})`);
            const [bale] = await tx.select({
              id: factoryBales.id, deletedAt: factoryBales.deletedAt,
            }).from(factoryBales)
              .where(and(eq(factoryBales.companyId, companyId), eq(factoryBales.id, itemId))).limit(1);
            if (!bale) return "missing";
            if (!bale.deletedAt) return "already-active";

            // Physical stock removals have already debited ERP inventory and
            // appended canonical journal evidence. Simply clearing deletedAt
            // would create a bale without inventory. It needs a controlled
            // re-entry with a new receipt and audit workflow instead.
            const removal = firstRow(await tx.execute(sql`
              SELECT id FROM canonical_stock_movements
               WHERE company_id = ${companyId}
                 AND source_type = 'factory_bale_removal'
                 AND source_id = ${String(itemId)}
               LIMIT 1
            `));
            if (removal) return "requires-reentry";
            await tx.update(factoryBales)
              .set({ deletedAt: null, status: "IN_STOCK", updatedAt: new Date() })
              .where(and(eq(factoryBales.id, itemId), eq(factoryBales.companyId, companyId)));
            return "restored";
          });
          if (result === "missing") return res.status(404).json({ message: "Bale not found" });
          if (result === "already-active") return res.status(409).json({ message: "Bale is not deleted" });
          if (result === "requires-reentry") {
            return res.status(409).json({
              message: "This physical bale removal has an ERP inventory reversal. Use a controlled stock re-entry; restoring the status alone would create phantom inventory.",
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
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
