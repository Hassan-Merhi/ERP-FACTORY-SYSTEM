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
import { stockItemLocationPrices, stockItems } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { saveLocationPrice, PosPriceWriteError } from "../../../services/pos/posPriceListEdit";
import { ActiveCompanyPermissionContextError } from "../../../services/security/activeCompanyPermissionContext";
import { z } from "zod";
import {
  emptyBody,
  emptyQuery,
  stringIdParams,
  validateRequest,
  type RequestSchemas,
} from "../../../lib/validateRequest";

// saveLocationPrice checks the ids and the price and answers POS_PRICE_INPUT_INVALID.
const saveLocationPriceInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: z.strictObject({
    locationId: z.union([z.number(), z.string()]).nullable().optional(),
    sellingPrice: z.union([z.number(), z.string()]).nullable().optional(),
  }),
} satisfies RequestSchemas;

// The handler reads the id with parseInt.
const deleteLocationPriceInput = {
  params: stringIdParams,
  query: emptyQuery,
  body: emptyBody,
} satisfies RequestSchemas;

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

  // Inline prices are editable by assigned, non-view-only POS cashiers too.
  app.post(
    "/api/stock-items/:id/location-prices",
    requireAuth,
    validateRequest(saveLocationPriceInput),
    async (req, res) => {
      try {
        const result = await saveLocationPrice(req, req.params.id, req.body?.locationId, req.body?.sellingPrice);
        res.json({ message: "Location price updated successfully", ...result });
      } catch (error: unknown) {
        if (error instanceof PosPriceWriteError || error instanceof ActiveCompanyPermissionContextError) {
          return res.status(error.status).json({ code: error.code, message: error.message });
        }
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Delete location price
  app.delete(
    "/api/stock-item-location-prices/:id",
    requireAuth,
    requireNonPOS,
    validateRequest(deleteLocationPriceInput),
    async (req, res) => {
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
    }
  );

  // ── Location Price Groups ──────────────────────────────────────────────────
  // GET: returns { masterLocationId, followerLocationIds[] } for each master
}
