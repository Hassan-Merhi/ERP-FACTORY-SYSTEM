import type { Express } from "express";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { inventory, locations, stockItems } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { toMoney } from "../../lib/money";

export function registerInventoryDebugRoutes(app: Express) {
  app.get(
    "/api/debug/inventory/:stockItemId",
    requireAuth,
    requireRole("Admin", "Developer", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }

        const { stockItemId } = req.params;
        const parsedStockItemId = parseInt(stockItemId);

        const stockItem = await db
          .select()
          .from(stockItems)
          .where(and(eq(stockItems.id, parsedStockItemId), eq(stockItems.companyId, companyId)))
          .execute();

        if (stockItem.length === 0) {
          return res.status(404).json({ message: "Stock item not found" });
        }

        const inventoryRecords = await db
          .select({
            id: inventory.id,
            locationId: inventory.locationId,
            locationName: locations.name,
            locationExists: locations.id,
            locationActive: locations.active,
            quantity: inventory.quantity,
            averageRate: inventory.averageRate,
            totalValue: inventory.totalValue,
            lastUpdated: inventory.lastUpdated,
          })
          .from(inventory)
          .leftJoin(locations, eq(inventory.locationId, locations.id))
          .where(and(eq(inventory.stockItemId, parsedStockItemId), eq(inventory.companyId, companyId)))
          .execute();

        let totalQty = 0;
        let totalValue = 0;
        let activeQty = 0;
        let activeValue = 0;
        for (const rec of inventoryRecords) {
          const qty = parseFloat(rec.quantity);
          // The stored value (wave 11), not quantity × the rounded average rate.
          const val = toMoney(rec.totalValue).toNumber();
          totalQty += qty;
          totalValue += val;
          if (rec.locationExists !== null && rec.locationActive === true) {
            activeQty += qty;
            activeValue += val;
          }
        }

        res.json({
          stockItem: {
            id: stockItem[0].id,
            code: stockItem[0].code,
            name: stockItem[0].name,
            stockGroupId: stockItem[0].stockGroupId,
            openingQty: stockItem[0].openingQty,
            openingRate: stockItem[0].openingRate,
            openingValue: stockItem[0].openingValue,
          },
          inventoryRecords: inventoryRecords.map((record) => {
            const isDeleted = record.locationExists === null;
            const isInactive = record.locationActive === false;
            let status = "Active";
            let displayName = record.locationName || `Location ${record.locationId}`;

            if (isDeleted) {
              status = "DELETED";
              displayName = `[DELETED] Location ${record.locationId}`;
            } else if (isInactive) {
              status = "INACTIVE";
              displayName = `[INACTIVE] ${record.locationName}`;
            }

            const qty = parseFloat(record.quantity);
            const rate = parseFloat(record.averageRate);
            return {
              id: record.id,
              locationId: record.locationId,
              locationName: displayName,
              locationDeleted: isDeleted || isInactive,
              locationStatus: status,
              quantity: qty,
              averageRate: rate,
              totalValue: toMoney(record.totalValue).toNumber(),
              lastUpdated: record.lastUpdated,
            };
          }),
          totals: {
            recordCount: inventoryRecords.length,
            totalQuantity: totalQty,
            activeRecordCount: inventoryRecords.filter(
              (record) => record.locationExists !== null && record.locationActive === true
            ).length,
            activeQuantity: activeQty,
            activeValue,
            totalValue,
            calculatedRate: totalQty > 0 ? totalValue / totalQty : 0,
          },
        });
      } catch (error: unknown) {
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}
