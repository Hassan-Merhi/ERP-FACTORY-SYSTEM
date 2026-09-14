/**
 * Item search sidebar for the stock adjustment form: the suggestion list
 * that appears when an item cell is focused, with keyboard-highlighted
 * entries and stock/average-rate readouts.
 *
 * Extracted from StockAdjustmentFormView.tsx during the P1 god-file split.
 * Purely presentational over the model returned by useStockAdjustmentFormModel.
 */

import { formatNumber } from "@/lib/formatNumber";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Search } from "lucide-react";
import type { StockAdjustmentFormModel } from "./useStockAdjustmentFormModel";

export function AdjustmentItemSidebar({ model }: { model: StockAdjustmentFormModel }) {
  const {
    stockAdjustmentForm,
    locations,
    adjustmentLocationId,
    adjustmentSearchTerm,
    setAdjustmentSearchTerm,
    setAdjustmentHighlightedIndex,
    adjustmentHighlightedIndex,
    activeAdjustmentRow,
    filteredAdjustmentItems,
    showAdjustmentSidebar,
    setShowAdjustmentSidebar,
    adjustmentSidebarRef,
    formatAmount,
  } = model;

  if (!showAdjustmentSidebar) return null;

  return (
    <Card className="hidden sm:flex flex-col w-full lg:w-80 lg:sticky lg:top-4 max-h-[60vh] lg:max-h-[calc(100vh-12rem)] self-start">
      <div className="p-4 border-b">
        <div className="flex items-center justify-between gap-2 mb-2">
          <h3 className="text-sm font-semibold">Search Items</h3>
          <button
            onClick={() => setShowAdjustmentSidebar(false)}
            className="text-xs text-muted-foreground hover:text-foreground"
            data-testid="button-close-adjustment-sidebar"
          >
            ✕
          </button>
        </div>
        {adjustmentLocationId > 0 && (
          <p className="text-xs text-muted-foreground mb-3">
            {locations.find((l) => l.id === adjustmentLocationId)?.name}
          </p>
        )}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by name or code..."
            value={adjustmentSearchTerm}
            onChange={(e) => {
              setAdjustmentSearchTerm(e.target.value);
              setAdjustmentHighlightedIndex(0);
            }}
            className="pl-9"
            data-testid="input-adjustment-sidebar-search"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-2" ref={adjustmentSidebarRef}>
        <div className="space-y-1">
          {filteredAdjustmentItems.length === 0 ? (
            <div className="text-center py-8 text-sm text-muted-foreground">
              {adjustmentLocationId > 0 ? "No items found" : "Select a location first"}
            </div>
          ) : (
            filteredAdjustmentItems.map((item, idx) => {
              const stock = parseFloat(item.quantity || "0");
              const isHighlighted = idx === adjustmentHighlightedIndex && activeAdjustmentRow !== null;
              return (
                <button
                  key={item.stockItemId}
                  type="button"
                  data-adjustment-idx={idx}
                  className={`w-full text-left px-3 py-3 rounded-md hover-elevate active-elevate-2 ${stock === 0 ? "opacity-60" : ""} ${isHighlighted ? "bg-accent" : ""}`}
                  data-testid={`button-adjustment-suggest-item-${item.stockItemId}`}
                  onClick={() => {
                    if (activeAdjustmentRow !== null) {
                      stockAdjustmentForm.setValue(`entries.${activeAdjustmentRow}.stockItemId`, item.stockItemId);
                      stockAdjustmentForm.setValue(
                        `entries.${activeAdjustmentRow}.stockItemCode`,
                        item.stockItemCode || ""
                      );
                      stockAdjustmentForm.setValue(`entries.${activeAdjustmentRow}.stockItemName`, item.stockItemName);
                      stockAdjustmentForm.setValue(`entries.${activeAdjustmentRow}.rate`, item.averageRate || "0");
                      setAdjustmentSearchTerm("");
                      setShowAdjustmentSidebar(false);
                      setTimeout(() => {
                        const qty = document.querySelector(
                          `[data-testid="input-adjustment-qty-${activeAdjustmentRow}"]`
                        ) as HTMLInputElement;
                        if (qty) {
                          qty.focus();
                          qty.select();
                        }
                      }, 50);
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{item.stockItemName}</div>
                      <div className="text-xs text-muted-foreground">{item.stockItemCode}</div>
                    </div>
                    <div className="text-right">
                      <div className={`text-sm font-mono ${stock > 0 ? "text-green-600" : "text-muted-foreground"}`}>
                        {formatNumber(stock)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        @{formatAmount(parseFloat(item.averageRate || "0"))}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </Card>
  );
}
