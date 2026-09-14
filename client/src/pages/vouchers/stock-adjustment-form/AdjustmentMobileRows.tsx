/**
 * Mobile (card-per-row) rendering of the stock adjustment entries.
 *
 * Extracted from StockAdjustmentFormView.tsx during the P1 god-file split.
 * Purely presentational over the model returned by useStockAdjustmentFormModel.
 */

import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Plus, X } from "lucide-react";
import type { StockAdjustmentFormModel } from "./useStockAdjustmentFormModel";

export function AdjustmentMobileRows({ model }: { model: StockAdjustmentFormModel }) {
  const {
    stockAdjustmentForm,
    adjustmentFields,
    removeAdjustment,
    appendAdjustment,
    adjustmentEntries,
    adjustmentItemsWithInventory,
    filteredAdjustmentItems,
    activeAdjustmentRow,
    setActiveAdjustmentRow,
    adjustmentSearchTerm,
    setAdjustmentSearchTerm,
    setAdjustmentHighlightedIndex,
    setShowAdjustmentSidebar,
    adjustmentFocusIdRef,
    consumptionTotal,
    productionTotal,
    formatAmount,
  } = model;

  return (
    <div className="sm:hidden p-3 space-y-2">
      {adjustmentFields.map((field, index) => {
        const currentEntry = adjustmentEntries[index];
        const inventoryItem = adjustmentItemsWithInventory.find(
          (item) => item.stockItemId === currentEntry?.stockItemId
        );
        const availableQty = inventoryItem?.quantity || "0";
        const rowAmount = parseFloat(currentEntry?.quantity || "0") * parseFloat(currentEntry?.rate || "0");
        const mobileAdjItems = activeAdjustmentRow === index ? filteredAdjustmentItems.slice(0, 10) : [];
        return (
          <div key={field.id} className="border rounded-md p-3 space-y-2 bg-card">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">#{index + 1}</span>
              {adjustmentFields.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeAdjustment(index)}
                  className="h-7 w-7"
                  data-testid={`button-remove-adjustment-mobile-${index}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Type (P/C)</label>
                <input
                  type="text"
                  value={
                    currentEntry?.type === "PRODUCE" ? "Produce" : currentEntry?.type === "CONSUME" ? "Consume" : ""
                  }
                  onChange={(e) => {
                    const val = e.target.value.toLowerCase();
                    if (val.startsWith("p")) stockAdjustmentForm.setValue(`entries.${index}.type`, "PRODUCE");
                    else if (val.startsWith("c")) stockAdjustmentForm.setValue(`entries.${index}.type`, "CONSUME");
                  }}
                  placeholder="p / c"
                  data-testid={`input-adjustment-type-mobile-${index}`}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring"
                />
              </div>
              {currentEntry?.stockItemId > 0 && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Available</label>
                  <div className="px-3 py-2 text-sm font-mono text-muted-foreground">
                    {formatNumber(parseFloat(availableQty))}
                  </div>
                </div>
              )}
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Item</label>
              <input
                type="text"
                value={activeAdjustmentRow === index ? adjustmentSearchTerm : currentEntry?.stockItemName || ""}
                onChange={(e) => {
                  setAdjustmentSearchTerm(e.target.value);
                  setAdjustmentHighlightedIndex(0);
                  if (!e.target.value) {
                    stockAdjustmentForm.setValue(`entries.${index}.stockItemId`, 0);
                    stockAdjustmentForm.setValue(`entries.${index}.stockItemCode`, "");
                    stockAdjustmentForm.setValue(`entries.${index}.stockItemName`, "");
                  }
                }}
                onFocus={() => {
                  adjustmentFocusIdRef.current += 1;
                  setActiveAdjustmentRow(index);
                  setAdjustmentSearchTerm(currentEntry?.stockItemName || "");
                  setAdjustmentHighlightedIndex(0);
                  setShowAdjustmentSidebar(true);
                }}
                onBlur={() => {
                  const focusId = adjustmentFocusIdRef.current;
                  setTimeout(() => {
                    if (adjustmentFocusIdRef.current === focusId) {
                      setActiveAdjustmentRow(null);
                      setAdjustmentSearchTerm("");
                      setShowAdjustmentSidebar(false);
                    }
                  }, 200);
                }}
                placeholder="Type to search item..."
                data-testid={`input-adjustment-item-mobile-${index}`}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring"
              />
              {mobileAdjItems.length > 0 && (
                <div className="border rounded-md bg-popover shadow-md max-h-40 overflow-y-auto z-20 relative">
                  {mobileAdjItems.map((item) => (
                    <button
                      key={item.stockItemId}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover-elevate border-b last:border-b-0"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        stockAdjustmentForm.setValue(`entries.${index}.stockItemId`, item.stockItemId);
                        stockAdjustmentForm.setValue(`entries.${index}.stockItemCode`, item.stockItemCode || "");
                        stockAdjustmentForm.setValue(`entries.${index}.stockItemName`, item.stockItemName);
                        stockAdjustmentForm.setValue(`entries.${index}.rate`, item.averageRate || "0");
                        setAdjustmentSearchTerm("");
                        setShowAdjustmentSidebar(false);
                      }}
                    >
                      <div className="font-medium truncate">{item.stockItemName}</div>
                      <div className="text-xs text-muted-foreground">Avail: {formatNumber(Number(item.quantity))}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Qty</label>
                <input
                  type="number"
                  step="0.001"
                  value={currentEntry?.quantity || ""}
                  onChange={(e) => stockAdjustmentForm.setValue(`entries.${index}.quantity`, e.target.value)}
                  placeholder="0"
                  data-testid={`input-adjustment-qty-mobile-${index}`}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring font-mono text-right"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Rate</label>
                <input
                  type="number"
                  step="0.01"
                  value={currentEntry?.rate || ""}
                  onChange={(e) => stockAdjustmentForm.setValue(`entries.${index}.rate`, e.target.value)}
                  placeholder="0.00"
                  data-testid={`input-adjustment-rate-mobile-${index}`}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring font-mono text-right"
                />
              </div>
            </div>
            <div className="flex items-center justify-between px-1">
              <span className="text-xs text-muted-foreground">Amount</span>
              <span
                className={`text-sm font-mono font-medium ${currentEntry?.type === "CONSUME" ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}`}
              >
                {currentEntry?.type === "CONSUME" ? "-" : "+"}
                {formatAmount(rowAmount)}
              </span>
            </div>
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1 px-0.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            appendAdjustment({
              type: "CONSUME",
              stockItemId: 0,
              stockItemCode: "",
              stockItemName: "",
              quantity: "",
              rate: "",
            })
          }
          data-testid="button-add-adjustment-row-mobile"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Row
        </Button>
        <div className="text-right text-xs space-y-0.5">
          <div>
            <span className="text-muted-foreground">Consume: </span>
            <span className="text-destructive font-mono">{formatAmount(consumptionTotal)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">Produce: </span>
            <span className="text-emerald-600 font-mono">{formatAmount(productionTotal)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
