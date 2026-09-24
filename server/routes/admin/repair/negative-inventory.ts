import { searchAny } from "@shared/searchNormalization";
/**
 * adminRepairRoutes: AdminNegativeInventory endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import { inventory, stockItems, stockGroups, locations } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";

export function registerAdminNegativeInventoryRoutes(app: Express) {
  // Credit/Debit Note - handles customer returns with stock restoration
  // Separates refund rate (customer refund) from inventory cost (actual cost)
  app.get("/api/inventory/negative", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { search, locationId, stockGroupId } = req.query;

      const conditions = [eq(inventory.companyId, companyId), sql`CAST(${inventory.quantity} AS numeric) < 0`];

      if (locationId) {
        conditions.push(eq(inventory.locationId, parseInt(locationId as string)));
      }

      const results = await db
        .select({
          inventoryId: inventory.id,
          locationId: inventory.locationId,
          locationName: locations.name,
          stockItemId: inventory.stockItemId,
          code: stockItems.code,
          name: stockItems.name,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
          groupName: stockGroups.name,
          groupId: stockItems.stockGroupId,
        })
        .from(inventory)
        .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .where(and(...conditions))
        .orderBy(locations.name, stockItems.code);

      let filtered = results;

      if (stockGroupId) {
        const gid = parseInt(stockGroupId as string);
        filtered = filtered.filter((r) => r.groupId === gid);
      }

      if (search) {
        filtered = filtered.filter((r) => searchAny(search, r.code, r.name, r.locationName));
      }

      res.json(filtered);
    } catch (error: unknown) {
      logger.error("Negative inventory error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
