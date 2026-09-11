import { useMemo } from "react";
import type { CombinedStockRow, InventoryItem } from "./locationInventoryTypes";

interface UseCombinedStockRowsParams {
  allInventoryData: InventoryItem[];
  allStockGroupFilter: string;
  allStockCategoryFilter: string[];
  allStockLocationFilter: string;
  allStockSearchTerm: string;
}

export function useCombinedStockRows({
  allInventoryData,
  allStockGroupFilter,
  allStockCategoryFilter,
  allStockLocationFilter,
  allStockSearchTerm,
}: UseCombinedStockRowsParams) {
  const allInventoryLocations = useMemo(() => {
    const locs = new Map<number, { id: number; name: string }>();
    allInventoryData.forEach((item) => {
      if (item.locationId && !locs.has(item.locationId))
        locs.set(item.locationId, { id: item.locationId, name: item.locationName || "" });
    });
    return [...locs.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [allInventoryData]);

  const allInventoryGroups = useMemo(() => {
    const groups = new Map<string, { id: number | null; name: string }>();
    allInventoryData.forEach((item) => {
      const key = String(item.stockGroupId ?? "null");
      if (!groups.has(key))
        groups.set(key, { id: item.stockGroupId ?? null, name: item.stockGroupName || "Unassigned" });
    });
    return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [allInventoryData]);

  const combinedStockRows = useMemo(() => {
    type CombinedStockAccumulator = Omit<CombinedStockRow, "avgCost">;
    const itemMap = new Map<number, CombinedStockAccumulator>();
    allInventoryData.forEach((item) => {
      const qty = parseFloat(item.quantity || "0");
      if (qty === 0) return;
      if (!itemMap.has(item.stockItemId)) {
        itemMap.set(item.stockItemId, {
          stockItemId: item.stockItemId,
          stockItemName: item.stockItemName || "",
          stockItemCode: item.stockItemCode || "",
          stockGroupId: item.stockGroupId ?? null,
          stockGroupName: item.stockGroupName || "Unassigned",
          categoryId: item.categoryId ?? null,
          categoryName: item.categoryName ?? null,
          qtyByLocationName: {} as Record<string, number>,
          totalQty: 0,
          weightedCostSum: 0,
          totalValue: 0,
        });
      }
      const row = itemMap.get(item.stockItemId)!;
      const locName = item.locationName || "";
      row.qtyByLocationName[locName] = (row.qtyByLocationName[locName] || 0) + qty;
      row.totalQty += qty;
      const avgRate = parseFloat(item.averageRate || "0");
      row.weightedCostSum += qty * avgRate;
      row.totalValue += parseFloat(item.totalValue || "0");
    });
    return [...itemMap.values()].map((row) => ({
      ...row,
      avgCost: row.totalQty > 0 ? row.weightedCostSum / row.totalQty : 0,
    }));
  }, [allInventoryData]);

  const filteredCombinedRows = useMemo(() => {
    return combinedStockRows
      .filter((row) => {
        if (allStockGroupFilter) {
          if (allStockGroupFilter === "null") {
            if (row.stockGroupId !== null) return false;
          } else {
            if (String(row.stockGroupId) !== allStockGroupFilter) return false;
          }
        }
        if (allStockCategoryFilter.length > 0) {
          const rowCatId = row.categoryId == null ? "none" : String(row.categoryId);
          if (!allStockCategoryFilter.includes(rowCatId)) return false;
        }
        if (allStockLocationFilter) {
          if (!((row.qtyByLocationName[allStockLocationFilter] || 0) > 0)) return false;
        }
        if (allStockSearchTerm) {
          const s = allStockSearchTerm.toLowerCase();
          return row.stockItemName.toLowerCase().includes(s) || row.stockItemCode.toLowerCase().includes(s);
        }
        return true;
      })
      .sort(
        (a, b) => a.stockGroupName.localeCompare(b.stockGroupName) || a.stockItemName.localeCompare(b.stockItemName)
      );
  }, [combinedStockRows, allStockGroupFilter, allStockCategoryFilter, allStockLocationFilter, allStockSearchTerm]);

  return { allInventoryLocations, allInventoryGroups, filteredCombinedRows };
}
