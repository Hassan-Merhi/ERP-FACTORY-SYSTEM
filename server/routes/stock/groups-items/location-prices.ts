/**
 * stockGroupsItemsRoutes: StockItemLocationPrice endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { db } from "../../../db";
import { storage } from "../../../storage";
import { requireAuth, requireNonPOS } from "../../../auth";
import { ownLocationIds } from "../../helpers/companyOwnership";
import { locationPriceGroups, stockItemLocationPrices, stockItems } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export function registerStockItemLocationPriceRoutes(app: Express) {
  // Get all location prices for the current company (for export)
  app.get("/api/stock-item-location-prices/all", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const prices = await storage.getAllLocationPrices(companyId);
      res.json(prices);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get location prices for a stock item
  app.get("/api/stock-items/:id/location-prices", requireAuth, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      if (isNaN(stockItemId)) {
        return res.status(400).json({ message: "Invalid stock item ID" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const prices = await storage.getStockItemLocationPrices(stockItemId, companyId);
      res.json(prices);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update or create location price for a stock item (cascades to follower locations)
  app.post("/api/stock-items/:id/location-prices", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const stockItemId = parseInt(req.params.id);
      if (isNaN(stockItemId)) {
        return res.status(400).json({ message: "Invalid stock item ID" });
      }

      const { locationId, sellingPrice } = req.body;
      if (!locationId || !sellingPrice) {
        return res.status(400).json({ message: "Location ID and selling price are required" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // The location is a body id, outside the path-based company scope.
      if (!(await ownLocationIds(companyId, [locationId])).has(Number(locationId))) {
        return res.status(400).json({ message: "Location not found" });
      }

      // Save price for the target location
      await storage.upsertLocationPrice(stockItemId, locationId, sellingPrice);

      // Cascade to follower locations if this is a master location
      if (companyId) {
        const followers = await db
          .select({ followerLocationId: locationPriceGroups.followerLocationId })
          .from(locationPriceGroups)
          .where(
            and(eq(locationPriceGroups.companyId, companyId), eq(locationPriceGroups.masterLocationId, locationId))
          );
        for (const f of followers) {
          await storage.upsertLocationPrice(stockItemId, f.followerLocationId, sellingPrice);
        }
      }

      res.json({ message: "Location price updated successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Delete location price
  app.delete("/api/stock-item-location-prices/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const priceId = parseInt(req.params.id);
      if (isNaN(priceId)) {
        return res.status(400).json({ message: "Invalid price ID" });
      }

      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // Reached by id alone: the price must be on one of this company's stock items.
      const [owned] = await db
        .select({ id: stockItemLocationPrices.id })
        .from(stockItemLocationPrices)
        .innerJoin(stockItems, eq(stockItems.id, stockItemLocationPrices.stockItemId))
        .where(and(eq(stockItemLocationPrices.id, priceId), eq(stockItems.companyId, companyId)));
      if (!owned) return res.status(404).json({ message: "Not found" });

      await storage.deleteLocationPrice(priceId);
      res.json({ message: "Location price deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Location Price Groups ──────────────────────────────────────────────────
  // GET: returns { masterLocationId, followerLocationIds[] } for each master
}
