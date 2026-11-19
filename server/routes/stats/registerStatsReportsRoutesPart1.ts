// Extracted from ./statsReportsRoutes.ts to keep that module under the source-size cap.
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import {
  addInventoryValues,
  divideInventoryValues,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { inventory, locations, salesItems, stockItems, vouchers } from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { countedStockRowValue } from "../../services/inventory/stockValuation";
import { registerStatsReportsRoutesPart2 } from "./registerStatsReportsRoutesPart2";

const numberValue = (value: unknown) =>
  toInventoryDecimal(value as unknown as Parameters<typeof toInventoryDecimal>[0]).toNumber();

const percentage = (numerator: unknown, denominator: unknown) => {
  const divisor = toInventoryDecimal(denominator as unknown as Parameters<typeof toInventoryDecimal>[0]);
  return divisor.isZero()
    ? 0
    : multiplyInventoryValues(
        divideInventoryValues(numerator as unknown as Parameters<typeof divideInventoryValues>[0], divisor),
        100
      ).toNumber();
};

export function registerStatsReportsRoutesPart1(app: Express) {
  app.get("/api/reports/sales", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate, locationId, stockGroupId } = req.query;
      const conditions = [eq(vouchers.companyId, companyId)];
      if (startDate) conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
      if (locationId) conditions.push(eq(vouchers.locationId, parseInt(locationId as string)));

      let salesData = await db
        .select({
          id: salesItems.id,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          locationName: locations.name,
          stockItemCode: stockItems.code,
          stockItemName: stockItems.name,
          stockGroupId: stockItems.stockGroupId,
          quantity: salesItems.quantity,
          sellingPrice: salesItems.sellingPrice,
          costPrice: salesItems.costPrice,
          totalSales: salesItems.totalSales,
          totalCost: salesItems.totalCost,
          profit: sql<string>`COALESCE(${salesItems.totalSales}::numeric, 0) - COALESCE(${salesItems.totalCost}::numeric, 0)`,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .where(and(...conditions))
        .orderBy(vouchers.voucherDate)
        .execute();
      if (stockGroupId) salesData = salesData.filter((item) => item.stockGroupId === parseInt(stockGroupId as string));

      const totalQuantity = addInventoryValues(...salesData.map((item) => item.quantity));
      const totalSales = addInventoryValues(...salesData.map((item) => item.totalSales));
      const totalCost = addInventoryValues(...salesData.map((item) => item.totalCost));
      const totalProfit = addInventoryValues(...salesData.map((item) => item.profit));
      res.json({
        items: salesData,
        summary: {
          totalQuantity: totalQuantity.toNumber(),
          totalSales: totalSales.toNumber(),
          totalCost: totalCost.toNumber(),
          totalProfit: totalProfit.toNumber(),
          grossProfitMargin: percentage(totalProfit, totalSales),
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          locationId: locationId || null,
          stockGroupId: stockGroupId || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/reports/stock-movement", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { startDate, endDate, locationId, stockGroupId } = req.query;
      const allStockItems = await storage.getAllStockItems(companyId);
      const stockItemsToReport = stockGroupId
        ? allStockItems.filter((item) => item.stockGroupId === parseInt(stockGroupId as string))
        : allStockItems;
      // Wave 11: the stock valuation policy (stockValuation.ts): non-deleted
      // locations, each row valued at its stored total_value.
      const inventoryConditions = [eq(locations.companyId, companyId), isNull(locations.deletedAt)];
      if (locationId) inventoryConditions.push(eq(inventory.locationId, parseInt(locationId as string)));
      const inventoryRecords = await db
        .select({
          stockItemId: inventory.stockItemId,
          locationId: inventory.locationId,
          locationName: locations.name,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
          totalValue: inventory.totalValue,
        })
        .from(inventory)
        .innerJoin(locations, eq(inventory.locationId, locations.id))
        .where(and(...inventoryConditions))
        .execute();

      const inventoryByItem = new Map<number, typeof inventoryRecords>();
      for (const record of inventoryRecords) {
        const records = inventoryByItem.get(record.stockItemId) || [];
        records.push(record);
        inventoryByItem.set(record.stockItemId, records);
      }

      const movementData = stockItemsToReport
        .map((item) => {
          const itemInventory = inventoryByItem.get(item.id) || [];
          const totalQuantity = addInventoryValues(...itemInventory.map((record) => record.quantity));
          const totalValue = addInventoryValues(
            ...itemInventory.map((record) => countedStockRowValue(record.quantity, record.totalValue))
          );
          return {
            stockItemId: item.id,
            stockItemCode: item.code,
            stockItemName: item.name,
            locations: itemInventory.map((record) => ({
              locationId: record.locationId,
              locationName: record.locationName,
              quantity: numberValue(record.quantity),
              averageRate: numberValue(record.averageRate),
              totalValue: countedStockRowValue(record.quantity, record.totalValue).toNumber(),
            })),
            totalQuantity: totalQuantity.toNumber(),
            totalValue: totalValue.toNumber(),
          };
        })
        .filter((item) => item.totalQuantity > 0);
      const grandTotalQuantity = addInventoryValues(...movementData.map((item) => item.totalQuantity));
      const grandTotalValue = addInventoryValues(...movementData.map((item) => item.totalValue));
      res.json({
        items: movementData,
        summary: {
          totalItems: movementData.length,
          grandTotalQuantity: grandTotalQuantity.toNumber(),
          grandTotalValue: grandTotalValue.toNumber(),
        },
        filters: {
          startDate: startDate || null,
          endDate: endDate || null,
          locationId: locationId || null,
          stockGroupId: stockGroupId || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerStatsReportsRoutesPart2(app);
}
