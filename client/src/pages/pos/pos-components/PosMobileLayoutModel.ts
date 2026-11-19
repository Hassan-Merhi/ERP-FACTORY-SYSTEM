// Extracted from ./PosMobileLayout.tsx: state, queries and handlers for PosMobileLayout.
import type { InventoryItem } from "./posTypes";
import { getFilteredInventory } from "../utils/posCalculations";
import { useState } from "react";
import type { PosMobileLayoutProps } from "./PosMobileLayout";

export function usePosMobileLayoutModel({
  searchTerm,
  inventory,
  selectItem,
  ensureItemSellable,
  rows,
}: {
  searchTerm: PosMobileLayoutProps["searchTerm"];
  inventory: PosMobileLayoutProps["inventory"];
  selectItem: PosMobileLayoutProps["selectItem"];
  ensureItemSellable: PosMobileLayoutProps["ensureItemSellable"];
  rows: PosMobileLayoutProps["rows"];
}) {
  const filteredInventory = getFilteredInventory(inventory, searchTerm).slice(0, 60);
  const validRows = rows.filter((row) => row.stockItemId && row.quantity > 0);
  // A line stays on screen while its quantity is being retyped. Filtering the
  // cards by quantity > 0 unmounted the line (and its focused input) the moment
  // a cashier cleared "1" to type "3", leaving an invisible zero-quantity row.
  const cartRows = rows.filter((row) => row.stockItemId);
  const total = validRows.reduce((sum, row) => sum + row.amount, 0);
  const quantity = validRows.reduce((sum, row) => sum + row.quantity, 0);
  const resultsId = "pos-mobile-product-results";
  // Tapping a result opens the item sheet (quantity + price) instead of adding a line at once.
  const [sheetItem, setSheetItem] = useState<InventoryItem | null>(null);

  const openItemSheet = (item: InventoryItem) => {
    if (!ensureItemSellable(item)) return;
    setSheetItem(item);
  };

  const addFromSheet = (item: InventoryItem, quantity: number, rate: number) => {
    // Same row placement, stock rule and currency handling as every other POS add; the search
    // is cleared by selectItem and focus returns to it when the sheet closes.
    selectItem(item, undefined, { quantity, rate });
    setSheetItem(null);
  };

  return {
    filteredInventory,
    validRows,
    cartRows,
    total,
    quantity,
    resultsId,
    sheetItem,
    setSheetItem,
    openItemSheet,
    addFromSheet,
  };
}

export type PosMobileLayoutModel = ReturnType<typeof usePosMobileLayoutModel>;
