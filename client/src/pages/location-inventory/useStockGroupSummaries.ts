import { searchAny } from "@shared/searchNormalization";
import { useMemo } from "react";
import type { InventoryItem, StockGroupSummary } from "./locationInventoryTypes";

interface UseStockGroupSummariesParams {
  openingInventoryData: InventoryItem[];
  inventoryData: InventoryItem[];
  closingInventoryData: InventoryItem[];
  openingInventoryLoading: boolean;
  closingInventoryLoading: boolean;
  inventoryLoading: boolean;
  fromDate: string;
  asOfDate: string;
  showZeroStock: boolean;
  showNegativeStock: boolean;
  groupSearchTerm: string;
  groupCategoryFilter: string;
  itemSearchTerm: string;
  itemCategoryFilter: string[];
  selectedGroup: StockGroupSummary | null;
}

export function useStockGroupSummaries({
  openingInventoryData,
  inventoryData,
  closingInventoryData,
  openingInventoryLoading,
  closingInventoryLoading,
  inventoryLoading,
  fromDate,
  asOfDate,
  showZeroStock,
  showNegativeStock,
  groupSearchTerm,
  groupCategoryFilter,
  itemSearchTerm,
  itemCategoryFilter,
  selectedGroup,
}: UseStockGroupSummariesParams) {
  const openingInventoryMap = useMemo(() => {
    const map = new Map<number, number>();
    openingInventoryData.forEach((item: InventoryItem) => map.set(item.stockItemId, parseFloat(item.quantity || "0")));
    return map;
  }, [openingInventoryData]);

  const showMovement = !!(fromDate && asOfDate);
  const activeInventoryData = showMovement ? closingInventoryData : inventoryData;
  const activeInventoryLoading = showMovement ? closingInventoryLoading || openingInventoryLoading : inventoryLoading;

  // All items (respecting zero filter)
  const inventory: InventoryItem[] = showZeroStock
    ? activeInventoryData
    : activeInventoryData.filter((item) => parseFloat(item.quantity || "0") !== 0);

  // Stock groups built from inventory
  const stockGroups: StockGroupSummary[] = useMemo(() => {
    const groups: StockGroupSummary[] = [];
    inventory.forEach((item) => {
      const groupId = item.stockGroupId ?? null;
      let group = groups.find((g) => g.groupId === groupId);
      if (!group) {
        group = {
          groupId,
          groupCode: item.stockGroupCode,
          groupName: item.stockGroupName || "Ungrouped",
          totalQuantity: 0,
          totalValue: 0,
          averageRate: 0,
          itemCount: 0,
          items: [],
        };
        groups.push(group);
      }
      const qty = parseFloat(item.quantity || "0");
      group.totalQuantity += qty;
      // Match Net Position valuation: quantity × average rate preserves the sign
      // of negative inventory instead of treating its stored total value as positive.
      const avgRate = parseFloat(item.averageRate || "0");
      group.totalValue += qty * avgRate;
      group.itemCount += 1;
      group.items.push(item);
    });
    groups.forEach((g) => {
      if (g.totalQuantity > 0) g.averageRate = g.totalValue / g.totalQuantity;
    });
    return groups.sort((a, b) => a.groupName.localeCompare(b.groupName));
  }, [inventory]);

  // Filter stock groups by search + category + negative stock toggle
  const filteredStockGroups = useMemo(() => {
    return stockGroups.filter((g) => {
      if (showNegativeStock && !g.items.some((item) => parseFloat(item.quantity || "0") < 0)) return false;
      if (groupSearchTerm && !searchAny(groupSearchTerm, g.groupName)) return false;
      if (groupCategoryFilter) {
        if (
          !g.items.some((item) => {
            if (groupCategoryFilter === "none") return item.categoryId == null;
            return String(item.categoryId) === groupCategoryFilter;
          })
        )
          return false;
      }
      return true;
    });
  }, [stockGroups, groupSearchTerm, groupCategoryFilter, showNegativeStock]);

  // Items within the selected group, with search + category + negative stock toggle
  const filteredStockItems = useMemo(() => {
    if (!selectedGroup) return [];
    return selectedGroup.items
      .filter((item) => {
        if (showNegativeStock && parseFloat(item.quantity || "0") >= 0) return false;
        if (itemCategoryFilter.length > 0) {
          const itemCatId = item.categoryId == null ? "none" : String(item.categoryId);
          if (!itemCategoryFilter.includes(itemCatId)) return false;
        }
        if (!itemSearchTerm) return true;
        return searchAny(itemSearchTerm, item.stockItemName, item.stockItemCode);
      })
      .sort((a, b) => a.stockItemName.localeCompare(b.stockItemName));
  }, [selectedGroup, itemSearchTerm, itemCategoryFilter, showNegativeStock]);

  // All items flat list (for view-all mode)
  const allItemsFiltered = useMemo(() => {
    return inventory
      .filter((item) => {
        if (showNegativeStock && parseFloat(item.quantity || "0") >= 0) return false;
        if (!itemSearchTerm) return true;
        return searchAny(itemSearchTerm, item.stockItemName, item.stockItemCode);
      })
      .sort(
        (a, b) =>
          (a.stockGroupName || "").localeCompare(b.stockGroupName || "") ||
          a.stockItemName.localeCompare(b.stockItemName)
      );
  }, [inventory, itemSearchTerm, showNegativeStock]);

  // Totals across all stock groups
  const totalQty = stockGroups.reduce((s, g) => s + g.totalQuantity, 0);
  const totalValue = stockGroups.reduce((s, g) => s + g.totalValue, 0);
  const totalItems = stockGroups.reduce((s, g) => s + g.itemCount, 0);

  return {
    openingInventoryMap,
    showMovement,
    activeInventoryData,
    activeInventoryLoading,
    inventory,
    stockGroups,
    filteredStockGroups,
    filteredStockItems,
    allItemsFiltered,
    totalQty,
    totalValue,
    totalItems,
  };
}
