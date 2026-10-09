import type { MarketRow } from "./itemMarketAnalysisParts";

/**
 * These two modes are market-price scenarios, not updates to posted sales.
 * Sales revenue is reported in USD; do not subtract a purchase rate denominated
 * in another currency without a reliable historical FX conversion.
 *
 * If an item has no eligible USD purchase/offload information for the chosen
 * date range, keep the historical posted profit instead of creating a zero-cost
 * or mixed-currency profit estimate.
 */
export function valueMarketRow(row: MarketRow, includeOffloadingCost: boolean): MarketRow {
  const unitCost = includeOffloadingCost ? row.weightedPurchaseCostWithOffloading : row.weightedPurchaseCost;
  const hasUsablePurchaseRate =
    row.importedQty > 0 &&
    row.purchaseCurrencies.length === 1 &&
    row.purchaseCurrencies[0]?.trim().toUpperCase() === "USD" &&
    unitCost != null &&
    Number.isFinite(unitCost) &&
    unitCost >= 0;

  if (!hasUsablePurchaseRate || row.soldQty <= 0) return row;

  // Returns are already netted out of soldQty and revenue by the report API.
  const profit = row.revenue - row.soldQty * unitCost;
  const marginPct = row.revenue === 0 ? 0 : (profit / row.revenue) * 100;
  const marketStatus: MarketRow["marketStatus"] =
    profit < 0 ? "losing" : marginPct >= 15 ? "strong" : "watch";

  return {
    ...row,
    profit,
    profitPerUnit: profit / row.soldQty,
    marginPct,
    marketStatus,
  };
}
