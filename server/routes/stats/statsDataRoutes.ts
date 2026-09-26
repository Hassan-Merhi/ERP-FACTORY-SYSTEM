import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  divideInventoryValues,
  multiplyInventoryValues,
  subtractInventoryValues,
  toInventoryDecimal,
} from "../../lib/inventoryMath";
import { db } from "../../db";
import { storage } from "../../storage";
import { getAccessibleCompanyIds } from "../../security/companyAccessBoundary";
import { requireAuth, requireNonPOS } from "../../auth";
import { stockItems, stockGroups, vouchers, salesItems, locations, stockItemLocationPrices } from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";

import { getMonthlyData, getStockSummary, getExpenseBreakdown } from "../../services/stats/dashboardStatsService";

function enhanceSalesReportItem<
  T extends {
    configuredSellingPrice: string | null;
    actualSellingPrice: string;
    totalSales: string;
    costProfit: string;
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
  const costProfit = toInventoryDecimal(item.costProfit);
  const costProfitPercentage = totalSales.isPositive()
    ? multiplyInventoryValues(divideInventoryValues(costProfit, totalSales), 100)
    : toInventoryDecimal(0);
  const configuredProfitPercentage = totalConfiguredCost.isPositive()
    ? multiplyInventoryValues(divideInventoryValues(configuredProfit, totalConfiguredCost), 100)
    : toInventoryDecimal(0);

  return {
    ...item,
    configuredSellingPrice: configuredPrice.toString(),
    configuredProfit: configuredProfit.toNumber(),
    totalConfiguredCost: totalConfiguredCost.toNumber(),
    costProfitPercentage: costProfitPercentage.toNumber(),
    configuredProfitPercentage: configuredProfitPercentage.toNumber(),
  };
}

export function registerStatsDataRoutes(app: Express) {
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
      res.json(await getExpenseBreakdown(companyId));
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
          configuredSellingPrice: stockItemLocationPrices.sellingPrice,
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
            eq(stockItemLocationPrices.locationId, vouchers.locationId)
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

  app.get("/api/sales-report/cogs-reconciliation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const result = await db.execute(sql`
        WITH opening AS (
          SELECT COALESCE(SUM(COALESCE(si.opening_value, 0)::numeric), 0) AS value
          FROM stock_items si
          WHERE si.company_id = ${companyId}
            AND si.deleted_at IS NULL
        ),
        offloads AS (
          SELECT COALESCE(SUM(coi.total_value::numeric), 0) AS value
          FROM container_offload_items coi
          INNER JOIN container_offloads co ON co.id = coi.offload_id
          INNER JOIN containers c ON c.id = co.container_id
          WHERE c.company_id = ${companyId}
            AND co.optional = false
        ),
        notes AS (
          SELECT COALESCE(SUM(
            CASE
              WHEN v.voucher_type = 'Credit Note'
                THEN cni.quantity::numeric * COALESCE(cni.inventory_cost, 0)::numeric
              WHEN v.voucher_type = 'Debit Note'
                THEN -(cni.quantity::numeric * COALESCE(cni.inventory_cost, 0)::numeric)
              ELSE 0
            END
          ), 0) AS value
          FROM credit_note_items cni
          INNER JOIN vouchers v ON v.id = cni.voucher_id
          WHERE v.company_id = ${companyId}
            AND v.optional = false
            AND v.deleted_at IS NULL
        ),
        adjustments AS (
          SELECT COALESCE(SUM(ve.credit_amount::numeric - ve.debit_amount::numeric), 0) AS value
          FROM voucher_entries ve
          INNER JOIN vouchers v ON v.id = ve.voucher_id
          INNER JOIN ledger_accounts la ON la.id = ve.ledger_account_id
          WHERE v.company_id = ${companyId}
            AND v.optional = false
            AND v.deleted_at IS NULL
            AND UPPER(COALESCE(la.code, '')) = 'STOCK_ADJUSTMENT'
        ),
        closing AS (
          SELECT COALESCE(SUM(i.quantity::numeric * i.average_rate::numeric), 0) AS value
          FROM inventory i
          INNER JOIN locations l ON l.id = i.location_id
          WHERE l.company_id = ${companyId}
            AND l.active = true
            AND l.deleted_at IS NULL
        ),
        sales AS (
          SELECT
            COALESCE(SUM(si.total_sales::numeric), 0) AS total_sales,
            COALESCE(SUM(si.total_cost::numeric), 0) AS stored_cogs
          FROM sales_items si
          INNER JOIN vouchers v ON v.id = si.voucher_id
          WHERE v.company_id = ${companyId}
            AND v.optional = false
            AND v.deleted_at IS NULL
        )
        SELECT
          opening.value AS opening_stock,
          offloads.value AS stock_received,
          notes.value AS note_inventory_net,
          adjustments.value AS stock_adjustment_net,
          closing.value AS closing_stock,
          sales.total_sales,
          sales.stored_cogs,
          (opening.value + offloads.value + notes.value + adjustments.value - closing.value) AS reconciled_cogs
        FROM opening, offloads, notes, adjustments, closing, sales
      `);

      const row = result.rows[0] as Record<string, string | number | null> | undefined;
      const num = (value: string | number | null | undefined) => Number.parseFloat(String(value ?? "0")) || 0;
      const openingStock = num(row?.opening_stock);
      const stockReceived = num(row?.stock_received);
      const noteInventoryNet = num(row?.note_inventory_net);
      const stockAdjustmentNet = num(row?.stock_adjustment_net);
      const closingStock = num(row?.closing_stock);
      const totalSales = num(row?.total_sales);
      const storedCogs = num(row?.stored_cogs);
      const reconciledCogs = num(row?.reconciled_cogs);
      const reconciliation = storedCogs - reconciledCogs;

      res.json({
        openingStock,
        stockReceived,
        noteInventoryNet,
        stockAdjustmentNet,
        closingStock,
        totalSales,
        storedCogs,
        reconciledCogs,
        reconciliation,
        storedCostProfit: totalSales - storedCogs,
        adjustedCostProfit: totalSales - reconciledCogs,
        formula:
          "Opening Stock + Stock Received + Net Credit/Debit Note Inventory + Stock Adjustment Net - Closing Stock",
      });
    } catch (error: unknown) {
      logger.error("Sales report COGS reconciliation error:", { error });
      res.status(500).json({ message: getErrorMessage(error), details: String(error) });
    }
  });

  app.get("/api/dashboard/sales-report-all", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ message: "Not authenticated" });

      const companyIds = Array.from(await getAccessibleCompanyIds(userId));
      if (companyIds.length === 0) return res.json([]);

      const allCompanies = await storage.getAllCompanies();
      const companyMap = new Map(allCompanies.map((company) => [company.id, company]));
      const { startDate, endDate, locationId, stockItemId, companyFilter, stockGroupName } = req.query;

      let filteredCompanyIds = companyIds;
      if (companyFilter && typeof companyFilter === "string" && companyFilter.length > 0) {
        const filterCodes = companyFilter.split(",");
        filteredCompanyIds = companyIds.filter((id) => {
          const company = companyMap.get(id);
          return company && filterCodes.includes(company.code);
        });
      }

      const allSalesData = [];
      for (const companyId of filteredCompanyIds) {
        const company = companyMap.get(companyId);
        const conditions = [
          eq(vouchers.companyId, companyId),
          eq(vouchers.optional, false),
          isNull(vouchers.deletedAt),
        ];
        if (startDate) conditions.push(sql`${vouchers.voucherDate} >= ${startDate}`);
        if (endDate) conditions.push(sql`${vouchers.voucherDate} <= ${endDate}`);
        if (locationId) conditions.push(eq(vouchers.locationId, parseInt(locationId as string)));
        if (stockItemId) conditions.push(eq(salesItems.stockItemId, parseInt(stockItemId as string)));

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
            stockGroupName: stockGroups.name,
            quantity: salesItems.quantity,
            actualSellingPrice: salesItems.sellingPrice,
            configuredSellingPrice: stockItemLocationPrices.sellingPrice,
            costPrice: salesItems.costPrice,
            totalSales: salesItems.totalSales,
            totalCost: salesItems.totalCost,
            costProfit: salesItems.profit,
            createdAt: salesItems.createdAt,
          })
          .from(salesItems)
          .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
          .innerJoin(stockItems, eq(salesItems.stockItemId, stockItems.id))
          .leftJoin(stockGroups, eq(stockItems.stockGroupId, stockGroups.id))
          .leftJoin(locations, eq(vouchers.locationId, locations.id))
          .leftJoin(
            stockItemLocationPrices,
            and(
              eq(stockItemLocationPrices.stockItemId, salesItems.stockItemId),
              eq(stockItemLocationPrices.locationId, vouchers.locationId)
            )
          )
          .where(and(...conditions, ...(stockGroupName ? [eq(stockGroups.name, stockGroupName as string)] : [])))
          .orderBy(vouchers.voucherDate);

        for (const item of salesData) {
          allSalesData.push({
            ...enhanceSalesReportItem(item),
            companyId,
            companyCode: company?.code || "",
            companyName: company?.name || "Unknown",
          });
        }
      }

      res.json(allSalesData);
    } catch (error: unknown) {
      logger.error("All companies sales report error:", { error });
      res.status(500).json({ message: getErrorMessage(error), details: String(error) });
    }
  });
}
