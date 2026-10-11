/**
 * adminRepairRoutes: AdminOrphanedPos endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import {
  assertNoInventoryCutoverTx,
  sendInventoryCutoverRefusal,
} from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import { inventory, vouchers, voucherEntries, salesItems, locations } from "@shared/schema";
import { eq, and, or, inArray, sql, isNull, isNotNull } from "drizzle-orm";
import { retireVouchersTx, sessionRetirementActor } from "../../../services/accounting/voucherRetirement";

export function registerAdminOrphanedPosRoutes(app: Express) {
  // Fix orphaned POS data that might be causing Import Cycle imbalance
  // This finds sales items linked to deleted vouchers and cleans them up
  app.post("/api/admin/fix-orphaned-pos-data", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const results = [];

      // 1. Find orphaned salesItems for THIS COMPANY (voucher is deleted but companyId matches)
      // We only clean up items where we can verify the company to prevent cross-company data loss
      const orphanedSalesItemsForCompany = await db
        .select({
          id: salesItems.id,
          voucherId: salesItems.voucherId,
          stockItemId: salesItems.stockItemId,
          quantity: salesItems.quantity,
          totalCost: salesItems.totalCost,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(and(eq(vouchers.companyId, companyId), isNotNull(vouchers.deletedAt)));

      // Also find completely orphaned salesItems (no voucher at all) - these are dangerous orphans
      // Get all salesItem voucherIds that don't have corresponding vouchers
      const allSalesItemVoucherIds = await db.selectDistinct({ voucherId: salesItems.voucherId }).from(salesItems);

      const existingVoucherIds = new Set((await db.select({ id: vouchers.id }).from(vouchers)).map((v) => v.id));

      const trulyOrphanedVoucherIds = allSalesItemVoucherIds
        .filter((item) => !existingVoucherIds.has(item.voucherId))
        .map((item) => item.voucherId);

      let trulyOrphanedSalesItems: typeof orphanedSalesItemsForCompany = [];
      if (trulyOrphanedVoucherIds.length > 0) {
        trulyOrphanedSalesItems = await db
          .select({
            id: salesItems.id,
            voucherId: salesItems.voucherId,
            stockItemId: salesItems.stockItemId,
            quantity: salesItems.quantity,
            totalCost: salesItems.totalCost,
          })
          .from(salesItems)
          .where(inArray(salesItems.voucherId, trulyOrphanedVoucherIds));
      }

      const allOrphanedSalesItems = [...orphanedSalesItemsForCompany, ...trulyOrphanedSalesItems];

      if (allOrphanedSalesItems.length > 0) {
        results.push({
          type: "orphaned_sales_items",
          count: allOrphanedSalesItems.length,
          companyScoped: orphanedSalesItemsForCompany.length,
          trulyOrphaned: trulyOrphanedSalesItems.length,
          totalCost: allOrphanedSalesItems.reduce((sum, item) => sum + parseFloat(item.totalCost || "0"), 0),
          details: allOrphanedSalesItems.slice(0, 10),
        });

        // Delete orphaned sales items
        for (const item of allOrphanedSalesItems) {
          await db.delete(salesItems).where(eq(salesItems.id, item.id));
        }
      }

      // 2. Find orphaned voucherEntries for THIS COMPANY (voucher is deleted but companyId matches)
      const orphanedEntriesForCompany = await db
        .select({
          id: voucherEntries.id,
          voucherId: voucherEntries.voucherId,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
        })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(voucherEntries.voucherId, vouchers.id))
        .where(and(eq(vouchers.companyId, companyId), isNotNull(vouchers.deletedAt)));

      // Also find completely orphaned entries (no voucher at all)
      const allEntryVoucherIds = await db.selectDistinct({ voucherId: voucherEntries.voucherId }).from(voucherEntries);

      const trulyOrphanedEntryVoucherIds = allEntryVoucherIds
        .filter((item) => item.voucherId && !existingVoucherIds.has(item.voucherId))
        .map((item) => item.voucherId);

      let trulyOrphanedEntries: typeof orphanedEntriesForCompany = [];
      if (trulyOrphanedEntryVoucherIds.length > 0) {
        trulyOrphanedEntries = await db
          .select({
            id: voucherEntries.id,
            voucherId: voucherEntries.voucherId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
          })
          .from(voucherEntries)
          .where(inArray(voucherEntries.voucherId, trulyOrphanedEntryVoucherIds as number[]));
      }

      const allOrphanedEntries = [...orphanedEntriesForCompany, ...trulyOrphanedEntries];

      if (allOrphanedEntries.length > 0) {
        const totalDebits = allOrphanedEntries.reduce((sum, e) => sum + parseFloat(e.debitAmount || "0"), 0);
        const totalCredits = allOrphanedEntries.reduce((sum, e) => sum + parseFloat(e.creditAmount || "0"), 0);

        results.push({
          type: "orphaned_voucher_entries",
          count: allOrphanedEntries.length,
          companyScoped: orphanedEntriesForCompany.length,
          trulyOrphaned: trulyOrphanedEntries.length,
          totalDebits,
          totalCredits,
        });

        // Wave 16 (A): listed, not deleted. The lines of a deleted voucher are
        // its history (a soft delete keeps them, and a retired linked journal
        // keeps them); this repair used to erase every one of them.
      }

      // 3. Check for negative inventory and log (don't fix automatically)
      const negativeInventory = await db
        .select({
          id: inventory.id,
          locationId: inventory.locationId,
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
        })
        .from(inventory)
        .where(and(eq(inventory.companyId, companyId), sql`CAST(${inventory.quantity} AS DECIMAL) < 0`));

      if (negativeInventory.length > 0) {
        results.push({
          type: "negative_inventory",
          count: negativeInventory.length,
          warning: "These need manual review - might indicate overselling or data issues",
          items: negativeInventory.slice(0, 10),
        });
      }

      res.json({
        message: `Cleanup complete: Fixed ${allOrphanedSalesItems.length} orphaned sales items, ${allOrphanedEntries.length} orphaned entries. Found ${negativeInventory.length} negative inventory items.`,
        results,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get orphaned POS sales (vouchers at deleted locations)
  app.get("/api/admin/orphaned-pos-sales", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all vouchers with locationId pointing to deleted or non-existent locations
      const orphanedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          locationId: vouchers.locationId,
          notes: vouchers.description,
        })
        .from(vouchers)
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            isNotNull(vouchers.locationId),
            or(
              isNull(locations.id), // Location doesn't exist
              isNotNull(locations.deletedAt) // Location is soft-deleted
            )
          )
        );

      // Get entry totals for each orphaned voucher
      const vouchersWithTotals = await Promise.all(
        orphanedVouchers.map(async (v) => {
          const entries = await db
            .select({
              debitAmount: voucherEntries.debitAmount,
              creditAmount: voucherEntries.creditAmount,
            })
            .from(voucherEntries)
            .where(eq(voucherEntries.voucherId, v.id));

          const totalDebit = entries.reduce((sum, e) => sum + parseFloat(e.debitAmount || "0"), 0);
          const totalCredit = entries.reduce((sum, e) => sum + parseFloat(e.creditAmount || "0"), 0);

          // Check if it has sales items
          const saleItems = await db
            .select({ id: salesItems.id, quantity: salesItems.quantity, totalCost: salesItems.totalCost })
            .from(salesItems)
            .where(eq(salesItems.voucherId, v.id));

          return {
            ...v,
            totalDebit,
            totalCredit,
            salesItemCount: saleItems.length,
            salesItemsTotalCost: saleItems.reduce((sum, s) => sum + parseFloat(s.totalCost || "0"), 0),
          };
        })
      );

      const totalImpact = vouchersWithTotals.reduce((sum, v) => sum + Math.abs(v.totalDebit - v.totalCredit), 0);

      res.json({
        count: vouchersWithTotals.length,
        totalImpact,
        vouchers: vouchersWithTotals,
        explanation:
          "These vouchers have a locationId that points to a deleted or non-existent location. They are orphaned and can be safely deleted.",
      });
    } catch (error: unknown) {
      logger.error("Orphaned POS sales check error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete orphaned POS sales (vouchers at deleted locations)
  app.post("/api/admin/delete-orphaned-pos-sales", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      // Wave 11: hard-deleting sales (and their COGS journals) would move the
      // ledger's Inventory with no stock movement: refused after the cut-over.
      await assertNoInventoryCutoverTx(db, companyId, "delete-orphaned-pos-sales");

      // Find all vouchers with locationId pointing to deleted or non-existent locations
      const orphanedVouchers = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
        })
        .from(vouchers)
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            isNotNull(vouchers.locationId),
            or(
              isNull(locations.id), // Location doesn't exist
              isNotNull(locations.deletedAt) // Location is soft-deleted
            )
          )
        );

      if (orphanedVouchers.length === 0) {
        return res.json({ message: "No orphaned POS sales found", deleted: 0 });
      }

      const voucherIds = orphanedVouchers.map((v) => v.id);

      // Wave 16 (A): one transaction; the vouchers are retired (soft delete
      // with their lines, audited here), not hard-deleted with their lines.
      const { deletedSalesItems, deletedEntries, deletedVouchers } = await db.transaction(async (tx) => {
        const salesResult = await tx.delete(salesItems).where(inArray(salesItems.voucherId, voucherIds));
        const lineRows = await tx
          .select({ id: voucherEntries.id })
          .from(voucherEntries)
          .where(inArray(voucherEntries.voucherId, voucherIds));
        const retired = await retireVouchersTx(tx, {
          companyId,
          voucherIds,
          reason: "orphaned-pos-sale-delete",
          actor: sessionRetirementActor(req),
        });
        return {
          deletedSalesItems: salesResult.rowCount ?? 0,
          deletedEntries: lineRows.length,
          deletedVouchers: retired.length,
        };
      });

      res.json({
        message: `Deleted ${deletedVouchers} orphaned POS vouchers, ${deletedEntries} entries, and ${deletedSalesItems} sales items`,
        deleted: deletedVouchers,
        deletedEntries,
        deletedSalesItems,
        voucherNumbers: orphanedVouchers.map((v) => v.voucherNumber),
      });
    } catch (error: unknown) {
      if (sendInventoryCutoverRefusal(res, error)) return;
      logger.error("Delete orphaned POS sales error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Role Feature Permissions API
  // Get all role permissions for the current company
}
