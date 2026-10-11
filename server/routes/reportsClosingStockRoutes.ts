/**
 * Closing-stock report routes.
 *
 * Current inventory value by stock group, plus the transfer / carry-forward
 * of closing stock and the per-group item breakdown. Extracted from
 * reportsRoutes.ts as a sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth, requireRole } from "../auth";
import {
  assertNoInventoryCutoverTx,
  sendInventoryCutoverRefusal,
} from "../services/accounting/perpetualInventory/cutoverRefusal";
import { factoryBaleMirrorStockItemIds } from "../services/accounting/perpetualInventory/factoryValuation";
import { countedStockRowValue } from "../services/inventory/stockValuation";

export const TRANSFER_CLOSING_STOCK_RETIRED_MESSAGE =
  "Transferring closing stock to another company has been retired: it moved stock value with no journal in either company. Use stock documents or the opening inventory journal instead.";
import {
  inventory,
  stockItems,
  vouchers,
  containers,
  containerOffloads,
  containerOffloadItems,
  locations,
  salesItems,
  stockAdjustmentVouchers,
  stockAdjustmentItems,
} from "@shared/schema";
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../lib/money";

type StockTotal = { quantity: Decimal; totalValue: Decimal };
const ZERO = new MoneyDecimal(0);
const NO_STOCK: StockTotal = { quantity: ZERO, totalValue: ZERO };

/** Adds an exact quantity and value to a stock item's running total. */
function addStock(target: Map<number, StockTotal>, stockItemId: number, quantity: Decimal, value: Decimal) {
  const existing = target.get(stockItemId) ?? NO_STOCK;
  target.set(stockItemId, {
    quantity: existing.quantity.plus(quantity),
    totalValue: existing.totalValue.plus(value),
  });
}

/** Total value over quantity, or 0 when there is no positive quantity. */
function averageRate({ quantity, totalValue }: StockTotal): Decimal {
  return quantity.greaterThan(0) ? totalValue.dividedBy(quantity) : ZERO;
}

/**
 * Stock by item over every non-deleted location of the company (active or
 * inactive), each row valued as the stock valuation counts it
 * (countedStockRowValue: total_value of a row holding stock, never negative)
 * and bale-mirror items at zero value (the factory values those bales), so
 * the report totals equal companyStockValuation().total (wave 11).
 */
async function countedInventoryByItem(companyId: number, itemIds?: number[]): Promise<Map<number, StockTotal>> {
  const conditions = [eq(locations.companyId, companyId), isNull(locations.deletedAt)];
  if (itemIds) conditions.push(inArray(inventory.stockItemId, itemIds));
  const [rows, mirror] = await Promise.all([
    db
      .select({
        stockItemId: inventory.stockItemId,
        quantity: inventory.quantity,
        totalValue: inventory.totalValue,
      })
      .from(inventory)
      .innerJoin(locations, eq(inventory.locationId, locations.id))
      .where(and(...conditions))
      .execute(),
    factoryBaleMirrorStockItemIds(db, companyId),
  ]);
  const byItem = new Map<number, StockTotal>();
  for (const row of rows) {
    const value = mirror.has(row.stockItemId) ? ZERO : countedStockRowValue(row.quantity, row.totalValue);
    addStock(byItem, row.stockItemId, toMoney(row.quantity), value);
  }
  return byItem;
}

export function registerReportsClosingStockRoutes(app: Express) {
  // Closing Stock Summary - Current inventory values by stock group
  app.get("/api/reports/closing-stock-summary", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get all stock groups for the company
      const allStockGroups = await storage.getAllStockGroups(companyId);

      // Get all stock items for the company
      const allStockItems = await storage.getAllStockItems(companyId);

      const inventoryByItem = await countedInventoryByItem(companyId);

      // Build stock groups summary
      const stockGroupSummary = allStockGroups
        .map((group) => {
          const groupItems = allStockItems.filter((item) => item.stockGroupId === group.id);

          let closing = NO_STOCK;
          for (const item of groupItems) {
            const invData = inventoryByItem.get(item.id);
            if (invData) {
              closing = {
                quantity: closing.quantity.plus(invData.quantity),
                totalValue: closing.totalValue.plus(invData.totalValue),
              };
            }
          }

          return {
            id: group.id,
            code: group.code,
            name: group.name,
            closingExact: closing,
            closing: {
              quantity: closing.quantity.toNumber(),
              rate: averageRate(closing).toNumber(),
              value: closing.totalValue.toNumber(),
            },
            itemCount: groupItems.length,
          };
        })
        .filter((g) => g.closingExact.quantity.greaterThan(0) || g.closingExact.totalValue.greaterThan(0));

      // Calculate grand totals
      const grandTotal = stockGroupSummary.reduce<StockTotal>(
        (sum, g) => ({
          quantity: sum.quantity.plus(g.closingExact.quantity),
          totalValue: sum.totalValue.plus(g.closingExact.totalValue),
        }),
        NO_STOCK
      );

      res.json({
        stockGroups: stockGroupSummary.map(({ closingExact: _closingExact, ...group }) => group),
        grandTotal: {
          quantity: grandTotal.quantity.toNumber(),
          rate: averageRate(grandTotal).toNumber(),
          value: grandTotal.totalValue.toNumber(),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Transfer Closing Stock to Another Company as Opening Stock — retired (wave 11).
  // It copied one company's stock into another as opening stock with no journal
  // in either company, so after a perpetual-inventory cut-over it would part the
  // ledger from the sub-ledger. It is gone for every company; the read-only
  // closing-stock reports stay.
  app.post("/api/reports/transfer-closing-stock", requireAuth, requireRole("Admin"), (_req, res) => {
    res.status(410).json({ code: "TRANSFER_CLOSING_STOCK_RETIRED", message: TRANSFER_CLOSING_STOCK_RETIRED_MESSAGE });
  });

  // Carry Forward Closing Stock to Opening Stock (same company)
  app.post("/api/reports/carryforward-closing-stock", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Wave 11: rewriting the opening stock is refused after the cut-over.
      await assertNoInventoryCutoverTx(db, companyId, "carryforward-closing-stock");

      const { asOfDate } = req.body;
      const targetDate = asOfDate ? new Date(asOfDate) : new Date();
      const targetDateStr = targetDate.toISOString().split("T")[0];

      // Current inventory of every non-deleted location, by stock item, valued
      // by total_value (the stock valuation policy).
      const aggregatedInventory = await countedInventoryByItem(companyId);

      // Get sales items from vouchers AFTER the target date and add them back
      // (Sales reduce inventory, so we add them back to get historical inventory)
      const salesAfterDate = await db
        .select({
          stockItemId: salesItems.stockItemId,
          quantity: salesItems.quantity,
          costPrice: salesItems.costPrice,
        })
        .from(salesItems)
        .innerJoin(vouchers, eq(salesItems.voucherId, vouchers.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            sql`${vouchers.voucherDate} > ${targetDateStr}`
          )
        )
        .execute();

      for (const sale of salesAfterDate) {
        const qty = toMoney(sale.quantity);
        addStock(aggregatedInventory, sale.stockItemId, qty, qty.times(toMoney(sale.costPrice)));
      }

      // Get stock adjustments AFTER the target date and reverse them
      // Production (positive qty) reduces historical inventory (subtract)
      // Consumption (negative qty) increases historical inventory (add back the consumed amount)
      const adjustmentsAfterDate = await db
        .select({
          stockItemId: stockAdjustmentItems.stockItemId,
          quantity: stockAdjustmentItems.quantity,
          rate: stockAdjustmentItems.rate,
        })
        .from(stockAdjustmentItems)
        .innerJoin(stockAdjustmentVouchers, eq(stockAdjustmentItems.adjustmentId, stockAdjustmentVouchers.id))
        .innerJoin(vouchers, eq(stockAdjustmentVouchers.voucherId, vouchers.id))
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.optional, false),
            sql`${vouchers.voucherDate} > ${targetDateStr}`
          )
        )
        .execute();

      for (const adj of adjustmentsAfterDate) {
        const qty = toMoney(adj.quantity);
        const val = qty.abs().times(toMoney(adj.rate));
        // Reverse the adjustment: subtract what was added (production), add back what was consumed
        addStock(
          aggregatedInventory,
          adj.stockItemId,
          qty.negated(),
          qty.greaterThanOrEqualTo(0) ? val.negated() : val
        );
      }

      // Get container offloads AFTER the target date and subtract them
      // (Container offloads add inventory, so we subtract them to get historical inventory)
      const offloadsAfterDate = await db
        .select({
          stockItemId: containerOffloadItems.stockItemId,
          quantity: containerOffloadItems.quantity,
          rate: containerOffloadItems.rate,
        })
        .from(containerOffloadItems)
        .innerJoin(containerOffloads, eq(containerOffloadItems.offloadId, containerOffloads.id))
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .where(and(eq(containers.companyId, companyId), sql`${containerOffloads.offloadedAt} > ${targetDate}`))
        .execute();

      for (const offload of offloadsAfterDate) {
        const qty = toMoney(offload.quantity);
        // Subtract offloaded items to reverse the inbound transaction
        addStock(aggregatedInventory, offload.stockItemId, qty.negated(), qty.times(toMoney(offload.rate)).negated());
      }

      // Filter out items with zero or negative quantities
      for (const [stockItemId, data] of Array.from(aggregatedInventory)) {
        if (data.quantity.lessThanOrEqualTo(0)) {
          aggregatedInventory.delete(stockItemId);
        }
      }

      if (aggregatedInventory.size === 0) {
        return res.status(400).json({ message: "No inventory found for the selected date" });
      }

      // Get all stock items for this company to update those with zero inventory
      const allStockItems = await db
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), eq(stockItems.active, true), isNull(stockItems.deletedAt)))
        .execute();

      let itemsUpdated = 0;
      let totalValue = ZERO;

      // Update stock items with calculated historical inventory as new opening stock
      await db.transaction(async (tx) => {
        // First, reset all stock items opening to zero
        for (const item of allStockItems) {
          if (!aggregatedInventory.has(item.id)) {
            await tx
              .update(stockItems)
              .set({
                openingQty: "0",
                openingRate: "0",
                openingValue: "0",
              })
              .where(eq(stockItems.id, item.id));
          }
        }

        // Then update items that have historical inventory
        for (const [stockItemId, data] of Array.from(aggregatedInventory)) {
          await tx
            .update(stockItems)
            .set({
              openingQty: data.quantity.toFixed(3),
              openingRate: averageRate(data).toFixed(2),
              openingValue: data.totalValue.toFixed(2),
            })
            .where(eq(stockItems.id, stockItemId));

          itemsUpdated++;
          totalValue = totalValue.plus(data.totalValue);
        }
      });

      const company = await storage.getCompanyById(companyId);

      res.json({
        success: true,
        message: `Successfully set opening stock for ${company?.name} as of ${targetDateStr}. ${itemsUpdated} items updated with total value $${totalValue.toFixed(2)}`,
        itemsUpdated,
        totalValue: totalValue.toFixed(2),
        asOfDate: targetDateStr,
      });
    } catch (error: unknown) {
      if (sendInventoryCutoverRefusal(res, error)) return;
      logger.error("Error carrying forward closing stock:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Closing Stock Detail - Items in a stock group
  app.get("/api/reports/closing-stock-summary/:stockGroupId/items", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { stockGroupId } = req.params;

      // Get stock items in this group
      const groupItems = await db
        .select()
        .from(stockItems)
        .where(
          and(
            eq(stockItems.companyId, companyId),
            eq(stockItems.stockGroupId, parseInt(stockGroupId)),
            eq(stockItems.active, true)
          )
        )
        .execute();

      // Get inventory for these items from active locations
      const itemIds = groupItems.map((i) => i.id);

      const inventoryByItem =
        itemIds.length > 0 ? await countedInventoryByItem(companyId, itemIds) : new Map<number, StockTotal>();

      // Build items list
      const items = groupItems
        .map((item) => {
          const invData = inventoryByItem.get(item.id) ?? NO_STOCK;
          return {
            invData,
            row: {
              id: item.id,
              code: item.code,
              name: item.name,
              closing: {
                quantity: invData.quantity.toNumber(),
                rate: averageRate(invData).toNumber(),
                value: invData.totalValue.toNumber(),
              },
            },
          };
        })
        .filter(({ invData }) => invData.quantity.greaterThan(0) || invData.totalValue.greaterThan(0));

      // Calculate totals
      const totals = items.reduce<StockTotal>(
        (sum, { invData }) => ({
          quantity: sum.quantity.plus(invData.quantity),
          totalValue: sum.totalValue.plus(invData.totalValue),
        }),
        NO_STOCK
      );

      res.json({
        items: items.map(({ row }) => row),
        totals: {
          quantity: totals.quantity.toNumber(),
          rate: averageRate(totals).toNumber(),
          value: totals.totalValue.toNumber(),
        },
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
