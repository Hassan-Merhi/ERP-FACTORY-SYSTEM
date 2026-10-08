/**
 * voucherTransferRoutes: SalesInventoryFix endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage, errorStatus } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  assertNoInventoryCutoverTx,
  sendInventoryCutoverRefusal,
} from "../../../services/accounting/perpetualInventory/cutoverRefusal";
import { inventory, stockItems, vouchers, salesItems, locations } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

export function registerSalesInventoryFixRoutes(app: Express) {
  // Fix inventory for Sales vouchers that were edited with location changes
  // This recalculates inventory based on current voucher locations
  app.post("/api/admin/fix-sales-inventory", requireAuth, async (req, res) => {
    try {
      // Admin only
      if (req.session.currentRole !== "Admin" && req.session.currentRole !== "Developer") {
        return res.status(403).json({ message: "Admin access required" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      // Wave 11: rewrites stock with no journal; refused after the cut-over.
      await assertNoInventoryCutoverTx(db, companyId, "fix-sales-inventory");

      // Get all Sales vouchers for this company
      const salesVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherType, "Sales")));

      const fixes = [];

      for (const voucher of salesVouchers) {
        if (!voucher.locationId) continue;

        // Get sales items for this voucher
        const items = await db.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id));

        for (const item of items) {
          const quantity = parseFloat(item.quantity);
          const _costPrice = parseFloat(item.costPrice);

          // Check if inventory at this location has this deduction
          const [inv] = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.locationId, voucher.locationId), eq(inventory.stockItemId, item.stockItemId)));

          fixes.push({
            voucherId: voucher.id,
            voucherNumber: voucher.voucherNumber,
            locationId: voucher.locationId,
            stockItemId: item.stockItemId,
            saleQuantity: quantity,
            currentInventory: inv ? parseFloat(inv.quantity) : null,
          });
        }
      }

      // Find inventory records with negative quantities that shouldn't have them
      const negativeInventory = await db
        .select({
          id: inventory.id,
          locationId: inventory.locationId,
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
          locationName: locations.name,
          stockItemName: stockItems.name,
        })
        .from(inventory)
        .leftJoin(locations, eq(inventory.locationId, locations.id))
        .leftJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .where(and(eq(inventory.companyId, companyId), sql`CAST(${inventory.quantity} AS DECIMAL) < 0`));

      // For each negative inventory, set it to 0 (cleanup orphaned deductions)
      const cleaned = [];
      for (const inv of negativeInventory) {
        // Check if there's actually a sale at this location that would cause this
        const salesAtLocation = await db
          .select()
          .from(salesItems)
          .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
          .where(
            and(
              eq(vouchers.locationId, inv.locationId),
              eq(salesItems.stockItemId, inv.stockItemId),
              eq(vouchers.companyId, companyId)
            )
          );

        if (salesAtLocation.length === 0) {
          // No sales at this location for this item - this is orphaned negative inventory
          // Reset to 0
          await db
            .update(inventory)
            .set({
              quantity: "0",
              totalValue: "0",
            })
            .where(eq(inventory.id, inv.id));

          cleaned.push({
            id: inv.id,
            locationName: inv.locationName,
            stockItemName: inv.stockItemName,
            oldQuantity: inv.quantity,
            action: "Reset to 0 (orphaned negative inventory)",
          });
        }
      }

      res.json({
        message: `Fixed ${cleaned.length} orphaned negative inventory records`,
        cleaned,
        salesVoucherCount: salesVouchers.length,
        negativeInventoryFound: negativeInventory.length,
      });
    } catch (error: unknown) {
      if (sendInventoryCutoverRefusal(res, error)) return;
      logger.error("[Fix Sales Inventory] Error:", { error: error });
      res.status(errorStatus(error)).json({ message: getErrorMessage(error) });
    }
  });

  // Get voucher entries for a specific voucher (for editing)
}
