/**
 * stockMergeRoutes: StockQuery endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { inventory, stockItems, stockGroups, locations } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { toMoney } from "../../../lib/money";

export function registerStockQueryRoutes(app: Express) {
  // Stock Query - Aggregated stock data across all locations
  app.get("/api/stock-query", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get all stock items for the company (excluding deleted)
      const allStockItems = await db
        .select({
          id: stockItems.id,
          code: stockItems.code,
          name: stockItems.name,
          uom: stockItems.uom,
          stockGroupId: stockItems.stockGroupId,
          stockGroupCode: stockGroups.code,
          stockGroupName: stockGroups.name,
          openingQty: stockItems.openingQty,
          openingRate: stockItems.openingRate,
          openingValue: stockItems.openingValue,
          sellingPrice: stockItems.sellingPrice,
          active: stockItems.active,
        })
        .from(stockItems)
        .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
        .where(and(eq(stockItems.companyId, req.session.currentCompanyId), isNull(stockItems.deletedAt)));

      // Get all inventory records for the company to calculate current qty and value
      const inventoryRecords = await db
        .select({
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(eq(locations.companyId, req.session.currentCompanyId));

      // Aggregate inventory by stock item at the stored total_value (wave 11),
      // never quantity × the rounded average rate.
      const inventoryMap = new Map<number, { totalQty: number; totalValue: number }>();

      for (const record of inventoryRecords) {
        const existing = inventoryMap.get(record.stockItemId) || {
          totalQty: 0,
          totalValue: 0,
        };
        const qty = parseFloat(record.quantity || "0");
        existing.totalQty += qty;
        existing.totalValue = toMoney(existing.totalValue).plus(toMoney(record.totalValue)).toNumber();
        inventoryMap.set(record.stockItemId, existing);
      }

      // Combine stock items with aggregated inventory
      const result = allStockItems.map((item) => {
        const inv = inventoryMap.get(item.id) || { totalQty: 0, totalValue: 0 };
        return {
          ...item,
          currentQty: inv.totalQty.toFixed(3),
          currentValue: inv.totalValue.toFixed(2),
        };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
