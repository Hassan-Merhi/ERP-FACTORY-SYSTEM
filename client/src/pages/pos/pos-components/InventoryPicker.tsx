import { useState, useEffect, useId } from "react";
import { Search, Package } from "lucide-react";
import { Card } from "@/components/ui/card";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { InventoryItem } from "./posTypes";
import { getPosPickerInventory } from "../utils/posCalculations";

export interface InventoryPickerProps {
  inventory: InventoryItem[];
  selectItem: (item: InventoryItem) => void;
  itemListRef: React.RefObject<HTMLDivElement | null>;
  highlightedIndex: number;
  setHighlightedIndex: React.Dispatch<React.SetStateAction<number>>;
  syncTerm?: string;
  mobile?: boolean;
}

export function InventoryPicker({
  inventory,
  selectItem,
  itemListRef,
  highlightedIndex,
  setHighlightedIndex,
  syncTerm,
  mobile = false,
}: InventoryPickerProps) {
  const [localSearch, setLocalSearch] = useState("");
  const pickerId = useId();
  const listboxId = `${pickerId}-items`;

  useEffect(() => {
    if (syncTerm !== undefined) setLocalSearch(syncTerm);
  }, [syncTerm]);

  // Use the exact same filtered/sorted list as keyboard navigation. The
  // highlighted index must point to one canonical item regardless of whether
  // the cashier clicks it or confirms it with Enter/Tab.
  const filteredInventory = getPosPickerInventory(inventory, localSearch);

  // Keep the selected option visible when cashiers navigate long lists using
  // the keyboard. This works for the independent right-hand search field,
  // not just the item-name cells in the sales grid.
  useEffect(() => {
    const list = itemListRef.current;
    if (!list || !filteredInventory.length) return;
    const option = list.children.item(highlightedIndex) as HTMLElement | null;
    if (!option) return;
    if (option.offsetTop < list.scrollTop) list.scrollTop = option.offsetTop;
    else if (option.offsetTop + option.offsetHeight > list.scrollTop + list.clientHeight) {
      list.scrollTop = option.offsetTop + option.offsetHeight - list.clientHeight;
    }
  }, [highlightedIndex, localSearch, inventory, itemListRef, filteredInventory.length]);

  const selectHighlighted = () => {
    const item = filteredInventory[highlightedIndex];
    if (!item) return;
    selectItem(item);
    setLocalSearch("");
    setHighlightedIndex(0);
  };

  return (
    <Card
      data-pos-inventory-picker="true"
      className={`flex flex-col overflow-hidden ${mobile ? "flex-1 rounded-none border-0 shadow-none" : "w-full lg:w-96 h-[300px] lg:h-auto shrink-0"}`}
    >
      {/* Header */}
      <div className={`shrink-0 ${mobile ? "px-4 pt-4 pb-3" : "px-3 pt-3 pb-2"}`}>
        <div data-pos-inventory-heading="true" className="flex items-center gap-1.5 mb-2">
          <Package className={`text-primary shrink-0 ${mobile ? "h-5 w-5" : "h-4 w-4"}`} />
          <p className={`font-bold text-foreground tracking-wide ${mobile ? "text-base" : "text-sm"}`}>Items</p>
        </div>
        <div
          data-pos-product-search="true"
          className={`flex items-center gap-2 rounded-md border border-primary bg-background px-2.5 focus-within:ring-2 focus-within:ring-primary/40 transition-all ${mobile ? "h-11" : "h-9"}`}
        >
          <Search className={`text-muted-foreground shrink-0 ${mobile ? "h-5 w-5" : "h-4 w-4"}`} />
          <input
            className={`flex-1 bg-transparent outline-hidden placeholder:text-muted-foreground ${mobile ? "text-base" : "text-sm"}`}
            placeholder="Scan barcode or search..."
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={filteredInventory.length > 0}
            aria-controls={listboxId}
            aria-activedescendant={filteredInventory.length > 0 ? `${pickerId}-item-${Math.min(highlightedIndex, filteredInventory.length - 1)}` : undefined}
            autoComplete="off"
            value={localSearch}
            onChange={(e) => {
              setLocalSearch(e.target.value);
              setHighlightedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filteredInventory.length > 0) {
                event.preventDefault();
                setHighlightedIndex((index) => Math.min(index + 1, filteredInventory.length - 1));
              } else if (event.key === "ArrowUp" && filteredInventory.length > 0) {
                event.preventDefault();
                setHighlightedIndex((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter" && filteredInventory.length > 0) {
                event.preventDefault();
                selectHighlighted();
              } else if (event.key === "Escape") {
                setLocalSearch("");
                setHighlightedIndex(0);
              }
            }}
            data-testid="input-product-search"
          />
          <MobileBarcodeScanner
            onScan={(code) => {
              const match = inventory.find((item) => item.code?.trim().toUpperCase() === code.trim().toUpperCase());
              if (match) {
                selectItem(match);
                setLocalSearch("");
                setHighlightedIndex(0);
              } else {
                setLocalSearch(code);
                setHighlightedIndex(0);
              }
            }}
          />
          {localSearch && (
            <button className="text-muted-foreground" onClick={() => { setLocalSearch(""); setHighlightedIndex(0); }} aria-label="Clear search">
              ×
            </button>
          )}
        </div>
      </div>

      {/* List */}
      <div
        data-pos-product-list="true"
        id={listboxId}
        role="listbox"
        aria-label="Matching inventory items"
        className="flex-1 overflow-y-auto"
        ref={itemListRef as React.RefObject<HTMLDivElement>}
      >
        {filteredInventory.map((item, index) => {
          const isOut = item.stock === 0;
          const isLow = !isOut && item.stock < 10;
          return (
            <button
              key={item.stockItemId ?? item.code}
              id={`${pickerId}-item-${index}`}
              role="option"
              aria-selected={index === highlightedIndex}
              tabIndex={-1}
              className={`w-full text-left flex items-center justify-between gap-2 border-b border-muted/40 transition-colors duration-100 ${
                mobile ? "px-4 py-3 active:bg-primary/10" : "px-3 py-3"
              } ${index === highlightedIndex ? "bg-primary/25" : "hover:bg-muted/40"} ${isOut ? "opacity-50" : ""}`}
              onClick={() => {
                selectItem(item);
                setLocalSearch("");
                setHighlightedIndex(0);
              }}
              data-testid={`button-select-item-${item.stockItemId ?? item.code}`}
            >
              <div className="flex min-w-0 items-center gap-3">
                {!mobile && (
                  <span data-pos-product-avatar="true">
                    <Package className="h-5 w-5" aria-hidden="true" />
                  </span>
                )}
                <div className="min-w-0">
                  <p className={`font-semibold leading-tight truncate ${mobile ? "text-base" : "text-sm"}`}>
                    {item.name}
                  </p>
                  <p className={`text-muted-foreground font-mono ${mobile ? "text-xs mt-0.5" : "text-[11px]"}`}>
                    {item.code}
                  </p>
                </div>
              </div>
              <span
                className={`shrink-0 font-bold rounded ${mobile ? "text-xs px-2 py-1" : "text-[11px] px-1.5 py-0.5"} ${
                  isOut
                    ? "bg-red-500/15 text-red-500"
                    : isLow
                      ? "bg-amber-500/15 text-amber-500"
                      : "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
                }`}
              >
                {isOut ? "Out" : isLow ? `${Math.round(item.stock)} Low` : Math.round(item.stock).toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
    </Card>
  );
}
