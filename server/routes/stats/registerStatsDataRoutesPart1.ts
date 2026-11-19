// Extracted from ./statsDataRoutes.ts
import type { Express } from "express";
import { registerSupplierProfitReconciliationRoutes } from "./supplierProfitReconciliationRoutes";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  divideInventoryValues,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  stockItems,
  vouchers,
  salesItems,
  locations,
  stockItemLocationPrices,
  locationPriceGroups,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";
import { getMonthlyData, getStockSummary, getExpenseBreakdown } from "../../services/stats/dashboardStatsService";

export function enhanceSalesReportItem<
  T extends {
    configuredSellingPrice: string | null;
    actualSellingPrice: string;
    totalSales: string;
    costProfit: string;
    totalCost: string;
    quantity: string;
  },
>(item: T) {
  const locationPrice = toInventoryDecimal(item.configuredSellingPrice);
  const actualPrice = toInventoryDecimal(item.actualSellingPrice);
  const configuredPrice = locationPrice.isPositive() ? locationPrice : actualPrice;
  const quantity = toInventoryDecimal(item.quantity);
  const configuredProfit = multiplyInventoryValues(subtractInventoryValues(actualPrice, configuredPrice), quantity);
  const totalConfiguredCost = multiplyInventoryValues(configuredPrice, quantity);
  const totalSales = toInventoryDecimal(item.totalSales);
  // Display profit must reconcile to the exact booked line totals. Preserve
  // stored sales_items.profit as historical evidence; never recost a sale here.
  const costProfit = subtractInventoryValues(totalSales, toInventoryDecimal(item.totalCost));
  const costProfitPercentage = totalSales.isPositive()
    ? multiplyInventoryValues(divideInventoryValues(costProfit, totalSales), 100)
    : toInventoryDecimal(0);
  const configuredProfitPercentage = totalConfiguredCost.isPositive()
    ? multiplyInventoryValues(divideInventoryValues(configuredProfit, totalConfiguredCost), 100)
    : toInventoryDecimal(0);

  return {
    ...item,
    costProfit: costProfit.toString(),
    configuredSellingPrice: configuredPrice.toString(),
    configuredProfit: configuredProfit.toNumber(),
    totalConfiguredCost: totalConfiguredCost.toNumber(),
    costProfitPercentage: costProfitPercentage.toNumber(),
    configuredProfitPercentage: configuredProfitPercentage.toNumber(),
  };
}

// Match /api/pos/price-list: follower locations use their master location's
// price. The scalar subquery prevents duplicate sales rows if legacy group
// configuration accidentally contains more than one follower mapping.
export const effectiveSalesPriceLocation = sql<number>`COALESCE(
  (SELECT ${locationPriceGroups.masterLocationId}
   FROM ${locationPriceGroups}
   WHERE ${locationPriceGroups.companyId} = ${vouchers.companyId}
     AND ${locationPriceGroups.followerLocationId} = ${vouchers.locationId}
   ORDER BY ${locationPriceGroups.id}
   LIMIT 1),
  ${vouchers.locationId}
)`;

export function registerStatsDataRoutesPart1(app: Express) {
  registerSupplierProfitReconciliationRoutes(app);
  app.get("/api/stats/monthly-data", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await getMonthlyData(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/stats/stock-summary", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      res.json(await getStockSummary(companyId));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/stats/expense-breakdown", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // Optional period (wave 17 A), inclusive, YYYY-MM-DD.
      const range: { startDate?: string; endDate?: string } = {};
      for (const key of ["startDate", "endDate"] as const) {
        const raw = req.query[key];
        if (raw === undefined) continue;
        if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
          return res.status(400).json({
            message:
              key === "startDate"
                ? "startDate must be a single YYYY-MM-DD value"
                : "endDate must be a single YYYY-MM-DD value",
          });
        }
        range[key] = raw;
      }
      if (range.startDate && range.endDate && range.startDate > range.endDate) {
        return res.status(400).json({ message: "startDate must be on or before endDate" });
      }
      res.json(await getExpenseBreakdown(companyId, range));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sales-report", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { startDate, endDate, locationId, stockItemId, stockGroupId } = req.query;
      const conditions = [eq(vouchers.companyId, companyId), eq(vouchers.optional, false), isNull(vouchers.deletedAt)];
      if (startDate) conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
      if (endDate) conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
      if (locationId) conditions.push(eq(vouchers.locationId, parseInt(locationId as string)));
      if (stockItemId) conditions.push(eq(salesItems.stockItemId, parseInt(stockItemId as string)));
      if (stockGroupId) conditions.push(eq(stockItems.stockGroupId, parseInt(stockGroupId as string)));

      const salesData = await db
        .select({
          id: salesItems.id,
          voucherId: salesItems.voucherId,
          voucherNumber: vouchers.voucherNumber,
          voucherDate: vouchers.voucherDate,
          locationId: vouchers.locationId,
          locationName: sql<string>`COALESCE(${locations.name}, ${vouchers.locationName})`.as("location_name"),
          stockItemId: salesItems.stockItemId,
          stockItemCode: stockItems.code,
          stockItemName: stockItems.name,
          stockGroupId: stockItems.stockGroupId,
          quantity: salesItems.quantity,
          actualSellingPrice: salesItems.sellingPrice,
          configuredSellingPrice: sql<
            string | null
          >`COALESCE(${stockItemLocationPrices.sellingPrice}, ${stockItems.sellingPrice})`,
          costPrice: salesItems.costPrice,
          totalSales: salesItems.totalSales,
          totalCost: salesItems.totalCost,
          costProfit: salesItems.profit,
          isCreditSale: vouchers.isCreditSale,
          createdAt: salesItems.createdAt,
          customerName: sql<string | null>`(
            SELECT la.name
            FROM voucher_entries ve
            INNER JOIN ledger_accounts la ON ve.ledger_account_id = la.id
            WHERE ve.voucher_id = ${vouchers.id}
              AND cast(ve.debit_amount as numeric) > 0
              AND ve.ledger_account_id IS NOT NULL
            LIMIT 1
          )`.as("customer_name"),
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
        .leftJoin(locations, eq(vouchers.locationId, locations.id))
        .leftJoin(
          stockItemLocationPrices,
          and(
            eq(stockItemLocationPrices.stockItemId, salesItems.stockItemId),
            eq(stockItemLocationPrices.locationId, effectiveSalesPriceLocation)
          )
        )
        .where(and(...conditions))
        .orderBy(vouchers.voucherDate);

      res.json(salesData.map(enhanceSalesReportItem));
    } catch (error: unknown) {
      logger.error("Sales report error:", { error });
      res.status(500).json({ message: getErrorMessage(error), details: String(error) });
    }
  });
}
