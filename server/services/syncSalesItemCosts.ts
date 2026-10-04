/**
 * Historical sale costs are immutable.
 *
 * This module remains only for compatibility with older callers. Ordinary
 * inventory changes must never rewrite sales_items.costPrice / totalCost /
 * profit from today's inventory average.
 */
import { db } from "../db";
import {
  addInventoryValues,
  inventoryMoney,
  inventoryUnitCost,
  multiplyInventoryValues,
  toInventoryDecimal,
} from "../lib/inventoryMath";
import { inventory } from "@shared/schema";
import { eq, and } from "drizzle-orm";

export interface SyncSalesItemCostsResult {
  updatedCount: number;
  stockItemsProcessed: number;
}

/**
 * Compatibility no-op. Posted sales keep their transaction-time cost.
 */
export async function syncSalesItemCostsForStockItems(
  companyId: number,
  locationId: number,
  stockItemIds: number[]
): Promise<SyncSalesItemCostsResult> {
  void companyId;
  void locationId;
  return { updatedCount: 0, stockItemsProcessed: stockItemIds.length };
}

/**
 * Apply a legitimate inventory-only landed-cost delta without rewriting any
 * historical sales. This preserves the old API shape for the legacy offload
 * edit path while enforcing sale-cost immutability.
 */
export async function applyInventoryRateDeltaAndSync(
  companyId: number,
  locationId: number,
  stockItemIds: number[],
  delta: number
): Promise<SyncSalesItemCostsResult> {
  void companyId;
  if (stockItemIds.length === 0) return { updatedCount: 0, stockItemsProcessed: 0 };

  const rateDelta = toInventoryDecimal(delta);
  if (rateDelta.abs().greaterThan("0.001")) {
    for (const stockItemId of stockItemIds) {
      const [invRecord] = await db
        .select({
          id: inventory.id,
          quantity: inventory.quantity,
          averageRate: inventory.averageRate,
        })
        .from(inventory)
        .where(and(eq(inventory.stockItemId, stockItemId), eq(inventory.locationId, locationId)))
        .limit(1);

      if (!invRecord) continue;

      const candidateRate = addInventoryValues(invRecord.averageRate, rateDelta);
      const newRate = candidateRate.isNegative() ? toInventoryDecimal(0) : candidateRate;
      const newTotalValue = multiplyInventoryValues(invRecord.quantity, newRate);

      await db
        .update(inventory)
        .set({
          averageRate: inventoryUnitCost(newRate),
          totalValue: inventoryMoney(newTotalValue),
          lastUpdated: new Date(),
        })
        .where(eq(inventory.id, invRecord.id));
    }
  }

  return { updatedCount: 0, stockItemsProcessed: stockItemIds.length };
}
