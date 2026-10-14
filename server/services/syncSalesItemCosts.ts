/**
 * Historical sale costs are immutable.
 *
 * This module remains only for compatibility with older callers. Ordinary
 * inventory changes must never rewrite sales_items.costPrice / totalCost /
 * profit from today's inventory average.
 */

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
