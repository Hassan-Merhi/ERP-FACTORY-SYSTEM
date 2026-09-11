import type { SaleRow, InventoryItem } from "../pos-components/posTypes";
import { POS_COLUMNS, getFilteredInventory } from "../utils/posCalculations";

interface PosKeyboardNavigationParams {
  rows: SaleRow[];
  activeRow: number | null;
  highlightedIndex: number;
  inventory: InventoryItem[];
  setSelectedCell: React.Dispatch<React.SetStateAction<{ row: number; col: number }>>;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  setRows: React.Dispatch<React.SetStateAction<SaleRow[]>>;
  toast: (opts: { title: string; description?: string; variant?: "destructive" | "default" }) => void;
  focusCell: (row: number, col: number) => void;
  selectItem: (item: InventoryItem, targetRowOverride?: number) => void;
}

/**
 * Grid keyboard navigation (arrows, Enter, Tab, Backspace) for the POS sale
 * rows, including item-search highlight navigation.
 * Extracted from usePosHandlers.ts (Phase 18 structural split) — logic unchanged.
 */
export function usePosKeyboardNavigation({
  rows,
  activeRow,
  highlightedIndex,
  inventory,
  setSelectedCell,
  setHighlightedIndex,
  setRows,
  toast,
  focusCell,
  selectItem,
}: PosKeyboardNavigationParams) {
  // ISSUE 9: Real keyboard navigation — returns a handler bound to current searchTerm
  const makeHandleKeyDown = (searchTerm: string) => (e: React.KeyboardEvent, rowIndex: number, colIndex: number) => {
    const maxCol = POS_COLUMNS.length - 4; // Exclude plBale, totalPL, delete
    const isItemNameField = POS_COLUMNS[colIndex]?.key === "itemName";
    const filteredItems = getFilteredInventory(inventory, searchTerm);

    if (isItemNameField && filteredItems.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.min(prev + 1, filteredItems.length - 1));
        return;
      }
      if (e.key === "ArrowUp" && highlightedIndex > 0) {
        e.preventDefault();
        setHighlightedIndex((prev) => Math.max(prev - 1, 0));
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        if (filteredItems[highlightedIndex]) selectItem(filteredItems[highlightedIndex], rowIndex);
        return;
      }
    }

    const currentRow = rows[rowIndex];
    const hasUnselectedItem = isItemNameField && currentRow?.itemName?.trim() && !currentRow?.stockItemId;

    switch (e.key) {
      case "ArrowUp":
        if (!isItemNameField || filteredItems.length === 0) {
          if (hasUnselectedItem) {
            e.preventDefault();
            toast({
              title: "Invalid item",
              description: "Please select an item from the list.",
              variant: "destructive",
            });
            return;
          }
          e.preventDefault();
          if (rowIndex > 0) {
            setSelectedCell({ row: rowIndex - 1, col: colIndex });
            focusCell(rowIndex - 1, colIndex);
          }
        }
        break;
      case "ArrowDown":
        if (!isItemNameField || filteredItems.length === 0) {
          if (hasUnselectedItem) {
            e.preventDefault();
            toast({
              title: "Invalid item",
              description: "Please select an item from the list.",
              variant: "destructive",
            });
            return;
          }
          e.preventDefault();
          if (rowIndex < rows.length - 1) {
            setSelectedCell({ row: rowIndex + 1, col: colIndex });
            focusCell(rowIndex + 1, colIndex);
          }
        }
        break;
      case "Enter":
        if (!isItemNameField || filteredItems.length === 0) {
          if (hasUnselectedItem) {
            e.preventDefault();
            toast({
              title: "Invalid item",
              description: "Please select an item from the list.",
              variant: "destructive",
            });
            return;
          }
          e.preventDefault();
          if (POS_COLUMNS[colIndex]?.key === "quantity") {
            setSelectedCell({ row: rowIndex, col: colIndex + 1 });
            focusCell(rowIndex, colIndex + 1);
          } else if (POS_COLUMNS[colIndex]?.key === "rate") {
            if (!rows[rowIndex + 1]) {
              setRows((prev) => [
                ...prev,
                { id: String(Date.now()), itemName: "", quantity: 0, rate: 0, rateUSD: 0, amount: 0 },
              ]);
              setTimeout(() => focusCell(rows.length, 0), 50);
            } else {
              setSelectedCell({ row: rowIndex + 1, col: 0 });
              focusCell(rowIndex + 1, 0);
            }
          } else if (rowIndex < rows.length - 1) {
            setSelectedCell({ row: rowIndex + 1, col: colIndex });
            focusCell(rowIndex + 1, colIndex);
          }
        }
        break;
      case "ArrowLeft":
        e.preventDefault();
        if (colIndex > 0) {
          setSelectedCell({ row: rowIndex, col: colIndex - 1 });
          focusCell(rowIndex, colIndex - 1);
        }
        break;
      case "ArrowRight":
        if (hasUnselectedItem) {
          e.preventDefault();
          toast({ title: "Invalid item", description: "Please select an item from the list.", variant: "destructive" });
          return;
        }
        e.preventDefault();
        if (colIndex < maxCol) {
          setSelectedCell({ row: rowIndex, col: colIndex + 1 });
          focusCell(rowIndex, colIndex + 1);
        }
        break;
      case "Tab":
        if (isItemNameField && activeRow === rowIndex && filteredItems.length > 0 && !e.shiftKey) {
          e.preventDefault();
          if (filteredItems[highlightedIndex]) selectItem(filteredItems[highlightedIndex]);
          return;
        }
        if (hasUnselectedItem) {
          e.preventDefault();
          toast({ title: "Invalid item", description: "Please select an item from the list.", variant: "destructive" });
          return;
        }
        if (!e.shiftKey && colIndex < maxCol) {
          e.preventDefault();
          setSelectedCell({ row: rowIndex, col: colIndex + 1 });
          focusCell(rowIndex, colIndex + 1);
        }
        break;
      case "Backspace": {
        const inputVal = (e.target as HTMLInputElement).value;
        if (inputVal === "" && (POS_COLUMNS[colIndex]?.key === "quantity" || POS_COLUMNS[colIndex]?.key === "rate")) {
          e.preventDefault();
          setSelectedCell({ row: rowIndex, col: colIndex - 1 });
          focusCell(rowIndex, colIndex - 1);
        }
        break;
      }
    }
  };

  return { makeHandleKeyDown };
}
