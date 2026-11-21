import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, checkPOSLocation } from "../../auth";
import { getClientDate } from "../../lib/dateUtils";
import { generateStockPdf } from "../../helpers/generateStockPdf";
import { inventory, stockItems, companies, stockGroups } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { registerLocationInventoryRoutesPart1, canViewInventoryCost } from "./registerLocationInventoryRoutesPart1";

const MAX_INVENTORY_RATE_STOCK_ITEM_IDS = 250;

export function registerLocationInventoryRoutes(app: Express) {
  app.get("/api/locations/:locationId/inventory-rates", requireAuth, checkPOSLocation, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) {
        return res.status(400).json({ message: "Invalid location ID" });
      }

      const location = await storage.getLocationById(locationId);
      if (!location) {
        return res.status(404).json({ message: "Location not found" });
      }
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied: Location belongs to a different company" });
      }

      if (!(await canViewInventoryCost(req))) {
        return res.status(403).json({
          code: "POS_INVENTORY_COST_FORBIDDEN",
          message: "Forbidden",
        });
      }

      const stockItemIdsParam = req.query.stockItemIds as string;
      if (!stockItemIdsParam) {
        return res.status(400).json({ message: "stockItemIds query parameter is required" });
      }
      const stockItemIds = Array.from(
        new Set(
          stockItemIdsParam
            .split(",")
            .map(Number)
            .filter((n) => !isNaN(n) && n > 0)
        )
      );
      if (stockItemIds.length === 0) {
        return res.json([]);
      }
      if (stockItemIds.length > MAX_INVENTORY_RATE_STOCK_ITEM_IDS) {
        return res.status(400).json({
          message: `A maximum of ${MAX_INVENTORY_RATE_STOCK_ITEM_IDS} stock item IDs can be requested at once`,
        });
      }

      const rows = await db
        .select({
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
          stockItemName: stockItems.name,
        })
        .from(inventory)
        .innerJoin(stockItems, eq(inventory.stockItemId, stockItems.id))
        .where(and(eq(inventory.locationId, locationId), inArray(inventory.stockItemId, stockItemIds)));

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerLocationInventoryRoutesPart1(app);

  // Location Inventory PDF — Godown Summary (with or without cost)
  app.get("/api/locations/:locationId/inventory/pdf", requireAuth, checkPOSLocation, async (req, res) => {
    try {
      const locationId = parseInt(req.params.locationId);
      if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

      const location = await storage.getLocationById(locationId);
      if (!location) return res.status(404).json({ message: "Location not found" });
      if (location.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({ message: "Access denied" });
      }

      const companyId = req.session.currentCompanyId!;
      const [co] = await db
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, companyId))
        .limit(1);
      const companyName = co?.name || "Company";

      const includeCost = req.query.includeCost !== "0" && req.query.includeCost !== "false";
      if (includeCost && !(await canViewInventoryCost(req))) {
        return res.status(403).json({
          code: "POS_INVENTORY_COST_FORBIDDEN",
          message: "Forbidden",
        });
      }

      const { buffer } = await generateStockPdf(companyId, companyName, locationId, location.name, includeCost);

      const safeDate = getClientDate(req).replace(/-/g, "");
      const safeName = location.name.replace(/[^\w\s.-]/g, "_").replace(/\s+/g, "_");
      const suffix = includeCost ? "with_cost" : "no_cost";
      const fileName = `${safeName}_Godown_${safeDate}_${suffix}.pdf`;

      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      res.send(buffer);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Location Inventory PDF — single Stock Group only
  app.get(
    "/api/locations/:locationId/inventory/pdf/stock-group/:groupId",
    requireAuth,
    checkPOSLocation,
    async (req, res) => {
      try {
        const locationId = parseInt(req.params.locationId);
        if (isNaN(locationId)) return res.status(400).json({ message: "Invalid location ID" });

        // ":groupId" of "none" exports the "Unassigned" pseudo-group (items with no stock group).
        const groupIdParam = req.params.groupId;
        const stockGroupId = groupIdParam === "none" ? null : parseInt(groupIdParam);
        if (stockGroupId !== null && isNaN(stockGroupId)) {
          return res.status(400).json({ message: "Invalid stock group ID" });
        }

        const location = await storage.getLocationById(locationId);
        if (!location) return res.status(404).json({ message: "Location not found" });
        if (location.companyId !== req.session.currentCompanyId) {
          return res.status(403).json({ message: "Access denied" });
        }

        const companyId = req.session.currentCompanyId!;
        const [co] = await db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, companyId))
          .limit(1);
        const companyName = co?.name || "Company";

        const includeCost = req.query.includeCost !== "0" && req.query.includeCost !== "false";
        if (includeCost && !(await canViewInventoryCost(req))) {
          return res.status(403).json({
            code: "POS_INVENTORY_COST_FORBIDDEN",
            message: "Forbidden",
          });
        }

        const { buffer, rowCount } = await generateStockPdf(
          companyId,
          companyName,
          locationId,
          location.name,
          includeCost,
          stockGroupId
        );
        if (rowCount === 0) {
          return res.status(404).json({ message: "No stock items found for this group at this location" });
        }

        let groupNameForFile = "Unassigned";
        if (stockGroupId !== null) {
          const [grp] = await db
            .select({ name: stockGroups.name })
            .from(stockGroups)
            .where(eq(stockGroups.id, stockGroupId))
            .limit(1);
          groupNameForFile = (grp?.name || String(stockGroupId)).replace(/[^\w\s.-]/g, "_").replace(/\s+/g, "_");
        }
        const safeDate = getClientDate(req).replace(/-/g, "");
        const safeName = location.name.replace(/[^\w\s.-]/g, "_").replace(/\s+/g, "_");
        const suffix = includeCost ? "with_cost" : "no_cost";
        const fileName = `${safeName}_${groupNameForFile}_${safeDate}_${suffix}.pdf`;

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
        res.send(buffer);
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
