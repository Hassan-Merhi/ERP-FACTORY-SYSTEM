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
import {
  inventory,
  stockItems,
  containers,
  vouchers,
  salesItems,
  suppliers,
  locations,
  companies,
} from "@shared/schema";
import { eq, and, inArray, sql, isNull } from "drizzle-orm";
import { _getCached, _setCached } from "../../services/shared/ttlCache";
import { countedStockRowValue } from "../../services/inventory/stockValuation";
import { getFinancialRatios } from "../../services/reports/financialReportsService";

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

export function registerStatsReportsRoutes(app: Express) {
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
          profit: salesItems.profit,
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

  app.get("/api/reports/containers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const { status, supplierId, startDate, endDate, allCompanies, specificCompanyId } = req.query;
      let companyCondition;
      if (allCompanies === "true") {
        const isDeveloper = req.user?.role === "Developer";
        const companyIds = isDeveloper
          ? (await storage.getAllCompanies()).map((company) => company.id)
          : (await storage.getUserCompaniesWithRoles(req.user!.id)).map((membership) => membership.companyId);
        companyCondition =
          companyIds.length > 0 ? inArray(containers.companyId, companyIds) : eq(containers.companyId, companyId);
      } else if (specificCompanyId) {
        companyCondition = eq(containers.companyId, parseInt(specificCompanyId as string));
      } else {
        companyCondition = eq(containers.companyId, companyId);
      }
      const conditions = [companyCondition];
      const isOffloaded = (status as string | undefined)?.toLowerCase() === "offloaded";
      if (status) conditions.push(eq(containers.status, isOffloaded ? "OFFLOADED" : (status as string)));
      if (supplierId) conditions.push(eq(containers.supplierId, parseInt(supplierId as string)));
      if (isOffloaded) {
        if (startDate) conditions.push(sql`${containers.offloadDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.offloadDate} <= ${endDate}`);
      } else {
        if (startDate) conditions.push(sql`${containers.importDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${containers.importDate} <= ${endDate}`);
      }
      const containerData = await db
        .select({
          id: containers.id,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: suppliers.legalName,
          status: containers.status,
          importDate: containers.importDate,
          offloadDate: containers.offloadDate,
          itemsTotal: containers.itemsTotal,
          chargesTotal: containers.chargesTotal,
          grandTotal: containers.grandTotal,
          companyId: containers.companyId,
          companyName: companies.name,
        })
        .from(containers)
        .innerJoin(suppliers, eq(containers.supplierId, suppliers.id))
        .innerJoin(companies, eq(containers.companyId, companies.id))
        .where(and(...conditions))
        .orderBy(
          isOffloaded ? sql`${containers.offloadDate} DESC NULLS LAST` : sql`${containers.importDate} DESC NULLS LAST`
        );
      res.json({
        containers: containerData,
        summary: {
          totalContainers: containerData.length,
          totalItemsTotal: addInventoryValues(...containerData.map((container) => container.itemsTotal)).toNumber(),
          totalChargesTotal: addInventoryValues(...containerData.map((container) => container.chargesTotal)).toNumber(),
          totalGrandTotal: addInventoryValues(...containerData.map((container) => container.grandTotal)).toNumber(),
        },
        filters: {
          status: status || null,
          supplierId: supplierId || null,
          startDate: startDate || null,
          endDate: endDate || null,
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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
