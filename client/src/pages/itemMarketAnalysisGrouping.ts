/** Pure item aggregation helpers shared by the Item Market Analysis view. */
import type { MarketRow } from "./itemMarketAnalysisParts";
import { getMarketStatus, normalizeItemCode } from "./itemMarketAnalysisParts";

export function getTopProfitCompanyByItem(rows: MarketRow[]) {
  const topByItem = new Map<
    string,
    { kind: "winner"; companyName: string; profit: number; marginPct: number } | { kind: "equal" } | { kind: "none" }
  >();
  const profitByCode = new Map<string, Map<number, { companyName: string; profit: number; revenue: number }>>();

  for (const row of rows) {
    const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
    const byCompany =
      profitByCode.get(itemKey) ?? new Map<number, { companyName: string; profit: number; revenue: number }>();
    const current = byCompany.get(row.companyId);
    byCompany.set(row.companyId, {
      companyName: row.companyName,
      profit: (current?.profit ?? 0) + row.profit,
      revenue: (current?.revenue ?? 0) + row.revenue,
    });
    profitByCode.set(itemKey, byCompany);
  }

  for (const [itemKey, byCompany] of profitByCode) {
    // "Top Profit Company" should only identify a market that actually made
    // positive profit. A company with no sales (profit = 0) must never beat a
    // company that sold the item at a loss, and if nobody made money we show None.
    const profitableValues = [...byCompany.values()]
      .filter((entry) => entry.revenue > 0 && entry.profit > 0)
      .sort((left, right) => right.profit - left.profit);

    if (profitableValues.length === 0) {
      topByItem.set(itemKey, { kind: "none" });
      continue;
    }

    const topProfit = profitableValues[0].profit;
    const tied = profitableValues.filter((entry) => Math.abs(entry.profit - topProfit) < 0.005);

    if (tied.length > 1) {
      topByItem.set(itemKey, { kind: "equal" });
      continue;
    }

    const best = profitableValues[0];
    topByItem.set(itemKey, {
      kind: "winner",
      companyName: best.companyName,
      profit: best.profit,
      marginPct: best.revenue === 0 ? 0 : (best.profit / best.revenue) * 100,
    });
  }

  return topByItem;
}

export function groupMarketRows(rows: MarketRow[]) {
  const grouped = new Map<string, MarketRow[]>();

  for (const row of rows) {
    const itemKey = normalizeItemCode(row.code) || `ID:${row.companyId}:${row.stockItemId}`;
    grouped.set(itemKey, [...(grouped.get(itemKey) ?? []), row]);
  }

  return [...grouped.entries()]
    .map(([itemKey, companyRows]) => {
      const orderedRows = [...companyRows].sort((left, right) => left.companyName.localeCompare(right.companyName));
      const firstRow = orderedRows[0]!;
      const importCount = orderedRows.reduce((sum, row) => sum + row.importCount, 0);
      const importedQty = orderedRows.reduce((sum, row) => sum + row.importedQty, 0);
      const soldQty = orderedRows.reduce((sum, row) => sum + row.soldQty, 0);
      const revenue = orderedRows.reduce((sum, row) => sum + row.revenue, 0);
      const historicalCost = orderedRows.reduce((sum, row) => sum + row.historicalCost, 0);
      const profit = orderedRows.reduce((sum, row) => sum + row.profit, 0);
      const purchaseCurrencies = [...new Set(orderedRows.flatMap((row) => row.purchaseCurrencies))];
      const purchaseValue =
        purchaseCurrencies.length === 1 ? orderedRows.reduce((sum, row) => sum + (row.purchaseValue ?? 0), 0) : null;
      const weightedPurchaseCost = purchaseValue != null && importedQty !== 0 ? purchaseValue / importedQty : null;
      const purchaseValueWithOffloading =
        purchaseCurrencies.length === 1
          ? orderedRows.reduce((sum, row) => sum + (row.purchaseValueWithOffloading ?? 0), 0)
          : null;
      const weightedPurchaseCostWithOffloading =
        purchaseValueWithOffloading != null && importedQty !== 0 ? purchaseValueWithOffloading / importedQty : null;
      const avgSellingPrice = soldQty === 0 ? 0 : revenue / soldQty;
      const profitPerUnit = soldQty === 0 ? 0 : profit / soldQty;
      const marginPct = revenue === 0 ? 0 : (profit / revenue) * 100;

      return {
        itemKey,
        code: firstRow.code,
        name: firstRow.name,
        stockGroupName: firstRow.stockGroupName,
        companyRows: orderedRows,
        importCount,
        importedQty,
        purchaseValue,
        weightedPurchaseCost,
        purchaseValueWithOffloading,
        weightedPurchaseCostWithOffloading,
        purchaseCurrencies,
        soldQty,
        revenue,
        historicalCost,
        profit,
        avgSellingPrice,
        profitPerUnit,
        marginPct,
        marketStatus: getMarketStatus(soldQty, profit, marginPct),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name) || left.itemKey.localeCompare(right.itemKey));
}
