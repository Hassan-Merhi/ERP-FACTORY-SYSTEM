import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { addInventoryValues, divideInventoryValues, toInventoryDecimal } from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { inventory, stockItems, locations } from "@shared/schema";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { _getCached, _setCached } from "../../services/shared/ttlCache";
import { countedStockRowValue } from "../../services/inventory/stockValuation";
import { getFinancialRatios } from "../../services/reports/financialReportsService";
import { registerStatsReportsRoutesPart1 } from "./registerStatsReportsRoutesPart1";

export function registerStatsReportsRoutes(app: Express) {
  registerStatsReportsRoutesPart1(app);
  registerStatsReportsRoutesPart2(app);
}

function registerStatsReportsRoutesPart2(app: Express) {
  app.get("/api/reports/ratios", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const startDate =
        typeof req.query.startDate === "string" && req.query.startDate ? req.query.startDate : undefined;
      const endDate = typeof req.query.endDate === "string" && req.query.endDate ? req.query.endDate : undefined;
      const cacheKey = `ratios:${companyId}:${startDate ?? ""}:${endDate ?? ""}`;
      const cached = _getCached(cacheKey);
      if (cached) return res.json(cached);
      // Wave 13 (R4): on the P&L and the balance sheet (see getFinancialRatios).
      const result = await getFinancialRatios(companyId, startDate, endDate);
      _setCached(cacheKey, result);
      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/opening-stock-summary", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { locationId } = req.query;
      const allStockGroups = await storage.getAllStockGroups(companyId);
      const allStockItems = await storage.getAllStockItems(companyId);
      const inventoryData = await db
        .select({
          stockItemId: inventory.stockItemId,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
          locationId: inventory.locationId,
          locationName: locations.name,
        })
        .from(inventory)
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(
          and(
            eq(inventory.companyId, companyId),
            // Wave 11: the stock valuation policy (non-deleted locations, active or not).
            isNull(locations.deletedAt),
            ...(locationId && locationId !== "all" ? [eq(inventory.locationId, parseInt(locationId as string))] : [])
          )
        )
        .execute();

      const inventoryByItem = new Map();
      for (const record of inventoryData) {
        const existing = inventoryByItem.get(record.stockItemId) || {
          quantity: toInventoryDecimal(0),
          totalValue: toInventoryDecimal(0),
        };
        existing.quantity = addInventoryValues(existing.quantity, record.quantity);
        existing.totalValue = addInventoryValues(
          existing.totalValue,
          countedStockRowValue(record.quantity, record.totalValue)
        );
        inventoryByItem.set(record.stockItemId, existing);
      }

      const stockGroupSummary = allStockGroups
        .map((group) => {
          const groupItems = allStockItems.filter((item) => item.stockGroupId === group.id);
          const openingQty = addInventoryValues(...groupItems.map((item) => item.openingQty));
          const openingValue = addInventoryValues(...groupItems.map((item) => item.openingValue));
          const closingQty = addInventoryValues(...groupItems.map((item) => inventoryByItem.get(item.id)?.quantity));
          const closingValue = addInventoryValues(
            ...groupItems.map((item) => inventoryByItem.get(item.id)?.totalValue)
          );
          return {
            id: group.id,
            code: group.code,
            name: group.name,
            opening: {
              quantity: openingQty.toNumber(),
              rate: openingQty.isPositive() ? divideInventoryValues(openingValue, openingQty).toNumber() : 0,
              value: openingValue.toNumber(),
            },
            closing: {
              quantity: closingQty.toNumber(),
              rate: closingQty.isPositive() ? divideInventoryValues(closingValue, closingQty).toNumber() : 0,
              value: closingValue.toNumber(),
            },
            itemCount: groupItems.length,
          };
        })
        .filter((group) => group.opening.quantity > 0 || group.closing.quantity > 0);
      res.json({
        stockGroups: stockGroupSummary,
        grandTotal: {
          opening: {
            quantity: addInventoryValues(...stockGroupSummary.map((group) => group.opening.quantity)).toNumber(),
            value: addInventoryValues(...stockGroupSummary.map((group) => group.opening.value)).toNumber(),
          },
          closing: {
            quantity: addInventoryValues(...stockGroupSummary.map((group) => group.closing.quantity)).toNumber(),
            value: addInventoryValues(...stockGroupSummary.map((group) => group.closing.value)).toNumber(),
          },
        },
        filters: { locationId: locationId || null },
        notes: {
          opening: "Opening balances are from stock item master data (not location-specific)",
          closing:
            locationId && locationId !== "all"
              ? "Closing balances are filtered by the selected location"
              : "Closing balances are aggregated across all locations",
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/opening-stock-summary/:stockGroupId/items", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { stockGroupId } = req.params;
      const { locationId } = req.query;
      const groupItems = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), eq(stockItems.stockGroupId, parseInt(stockGroupId))))
        .execute();
      const itemIds = groupItems.map((item) => item.id);
      let inventoryData: Array<{ stockItemId: number; quantity: string; averageRate: string; totalValue: string }> = [];
      if (itemIds.length > 0) {
        const conditions = [
          eq(inventory.companyId, companyId),
          inArray(inventory.stockItemId, itemIds),
          // Wave 11: the stock valuation policy (non-deleted locations, active or not).
          isNull(locations.deletedAt),
        ];
        if (locationId && locationId !== "all")
          conditions.push(eq(inventory.locationId, parseInt(locationId as string)));
        inventoryData = await db
          .select({
            stockItemId: inventory.stockItemId,
            quantity: inventory.quantity,
            averageRate: inventory.averageRate,
            totalValue: inventory.totalValue,
          })
          .from(inventory)
          .innerJoin(locations, eq(inventory.locationId, locations.id))
          .where(and(...conditions))
          .execute();
      }
      const inventoryByItem = new Map();
      for (const record of inventoryData) {
        const existing = inventoryByItem.get(record.stockItemId) || {
          quantity: toInventoryDecimal(0),
          totalValue: toInventoryDecimal(0),
        };
        existing.quantity = addInventoryValues(existing.quantity, record.quantity);
        existing.totalValue = addInventoryValues(
          existing.totalValue,
          countedStockRowValue(record.quantity, record.totalValue)
        );
        inventoryByItem.set(record.stockItemId, existing);
      }
      const items = groupItems
        .map((item) => {
          const openingQuantity = toInventoryDecimal(item.openingQty);
          const openingRate = toInventoryDecimal(item.openingRate);
          const openingValue = toInventoryDecimal(item.openingValue);
          const current = inventoryByItem.get(item.id) || {
            quantity: toInventoryDecimal(0),
            totalValue: toInventoryDecimal(0),
          };
          return {
            id: item.id,
            code: item.code,
            name: item.name,
            uom: item.uom,
            opening: {
              quantity: openingQuantity.toNumber(),
              rate: openingRate.toNumber(),
              value: openingValue.toNumber(),
            },
            closing: {
              quantity: current.quantity.toNumber(),
              rate: current.quantity.isPositive()
                ? divideInventoryValues(current.totalValue, current.quantity).toNumber()
                : 0,
              value: current.totalValue.toNumber(),
            },
          };
        })
        .filter((item) => item.opening.quantity > 0 || item.closing.quantity > 0);
      const stockGroup = await storage.getStockGroupById(parseInt(stockGroupId));
      res.json({
        items,
        grandTotal: {
          opening: {
            quantity: addInventoryValues(...items.map((item) => item.opening.quantity)).toNumber(),
            value: addInventoryValues(...items.map((item) => item.opening.value)).toNumber(),
          },
          closing: {
            quantity: addInventoryValues(...items.map((item) => item.closing.quantity)).toNumber(),
            value: addInventoryValues(...items.map((item) => item.closing.value)).toNumber(),
          },
        },
        stockGroup: stockGroup ? { id: stockGroup.id, code: stockGroup.code, name: stockGroup.name } : null,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
