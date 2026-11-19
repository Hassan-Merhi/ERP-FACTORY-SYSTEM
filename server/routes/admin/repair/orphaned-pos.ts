/**
 * adminRepairRoutes: AdminOrphanedPos endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { emptyBody, emptyQuery, validateRequest, type RequestSchemas } from "../../../lib/validateRequest";
import { inventory, vouchers, voucherEntries, salesItems } from "@shared/schema";
import { eq, and, inArray, sql, isNotNull } from "drizzle-orm";
import { plusMoney } from "../../../lib/money";
import { registerAdminOrphanedPosRoutesPart1 } from "./registerAdminOrphanedPosRoutesPart1";

/** This repair takes no input. */
const noInput = { query: emptyQuery, body: emptyBody } satisfies RequestSchemas;

export function registerAdminOrphanedPosRoutes(app: Express) {
  // Fix orphaned POS data that might be causing Import Cycle imbalance
  // This finds sales items linked to deleted vouchers and cleans them up
  app.post(
    "/api/admin/fix-orphaned-pos-data",
    requireAuth,
    requireRole("Admin"),
    validateRequest(noInput),
    async (req, res) => {
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
            totalCost: allOrphanedSalesItems.reduce((sum, item) => plusMoney(sum, item.totalCost), 0),
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
        const allEntryVoucherIds = await db
          .selectDistinct({ voucherId: voucherEntries.voucherId })
          .from(voucherEntries);

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
          const totalDebits = allOrphanedEntries.reduce((sum, e) => plusMoney(sum, e.debitAmount), 0);
          const totalCredits = allOrphanedEntries.reduce((sum, e) => plusMoney(sum, e.creditAmount), 0);

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
    }
  );

  registerAdminOrphanedPosRoutesPart1(app);

  // Role Feature Permissions API
  // Get all role permissions for the current company
}
