/**
 * Desktop (spreadsheet) rendering of the stock adjustment entries, including
 * the keyboard navigation contract (P/C keys, Tab, Enter, arrows between
 * rows and into the item suggestions).
 *
 * Extracted from StockAdjustmentFormView.tsx during the P1 god-file split.
 * Purely presentational over the model returned by useStockAdjustmentFormModel.
 */

import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import type { StockAdjustmentFormModel } from "./useStockAdjustmentFormModel";

export function AdjustmentSpreadsheet({ model }: { model: StockAdjustmentFormModel }) {
  const {
    stockAdjustmentForm,
    adjustmentFields,
    appendAdjustment,
    removeAdjustment,
    adjustmentEntries,
    adjustmentItemsWithInventory,
    filteredAdjustmentItems,
    adjustmentSearchTerm,
    setAdjustmentSearchTerm,
    adjustmentHighlightedIndex,
    setAdjustmentHighlightedIndex,
    activeAdjustmentRow,
    setActiveAdjustmentRow,
    showAdjustmentSidebar,
    setShowAdjustmentSidebar,
    adjustmentFocusIdRef,
    formatAmount,
  } = model;

  return (
    <div className="hidden sm:block overflow-x-auto">
      <div className="min-w-[400px]">
        <div className="flex bg-muted/50 border-b sticky top-0 z-30">
          <div className="w-10 sm:w-12 flex items-center justify-center border-r h-9 sm:h-10 font-medium text-xs">
            #
          </div>
          <div className="w-16 sm:w-24 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Type
          </div>
          <div className="flex-1 min-w-[120px] flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Item
          </div>
          <div className="w-16 sm:w-20 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm text-muted-foreground">
            Avail
          </div>
          <div className="w-16 sm:w-24 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Qty
          </div>
          <div className="w-16 sm:w-24 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm">
            Rate
          </div>
          <div className="w-20 sm:w-28 flex items-center px-2 sm:px-3 border-r h-9 sm:h-10 font-medium text-xs sm:text-sm bg-muted/30">
            Amt
          </div>
          <div className="w-10 sm:w-12 flex items-center justify-center h-9 sm:h-10" />
        </div>
        <div className="max-h-[calc(100vh-24rem)] overflow-y-auto">
          {adjustmentFields.map((field, index) => {
            const currentEntry = adjustmentEntries[index];
            const inventoryItem = adjustmentItemsWithInventory.find(
              (item) => item.stockItemId === currentEntry?.stockItemId
            );
            const availableQty = inventoryItem?.quantity || "0";
            return (
              <div key={field.id} className="flex border-b hover-elevate">
                <div className="w-10 sm:w-12 flex items-center justify-center border-r h-9 sm:h-10 text-xs text-muted-foreground">
                  {index + 1}
                </div>
                <div className="w-16 sm:w-24 border-r h-9 sm:h-10">
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
                    onKeyDown={(e) => {
                      if (e.key === "p" || e.key === "P") {
                        e.preventDefault();
                        stockAdjustmentForm.setValue(`entries.${index}.type`, "PRODUCE");
                      } else if (e.key === "c" || e.key === "C") {
                        e.preventDefault();
                        stockAdjustmentForm.setValue(`entries.${index}.type`, "CONSUME");
                      } else if (e.key === "Tab" && !e.shiftKey) {
                        e.preventDefault();
                        const item = document.querySelector(
                          `[data-testid="input-adjustment-item-${index}"]`
                        ) as HTMLInputElement;
                        if (item) {
                          item.focus();
                          item.select();
                        }
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const next = document.querySelector(
                          `[data-testid="input-adjustment-type-${index + 1}"]`
                        ) as HTMLInputElement;
                        if (next) next.focus();
                      } else if (e.key === "ArrowUp" && index > 0) {
                        e.preventDefault();
                        const prev = document.querySelector(
                          `[data-testid="input-adjustment-type-${index - 1}"]`
                        ) as HTMLInputElement;
                        if (prev) prev.focus();
                      }
                    }}
                    placeholder="p/c"
                    className="w-full h-full px-3 bg-transparent outline-none focus:bg-accent/20 text-sm"
                    data-testid={`input-adjustment-type-${index}`}
                  />
                </div>
                <div className="flex-1 min-w-[120px] border-r h-9 sm:h-10">
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
                      const focusIdAtBlur = adjustmentFocusIdRef.current;
                      setTimeout(() => {
                        if (adjustmentFocusIdRef.current === focusIdAtBlur) {
                          setActiveAdjustmentRow(null);
                          setAdjustmentSearchTerm("");
                          setShowAdjustmentSidebar(false);
                        }
                      }, 200);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" && !e.shiftKey) {
                        e.preventDefault();
                        if (showAdjustmentSidebar && filteredAdjustmentItems.length > 0)
                          setAdjustmentHighlightedIndex(Math.max(0, adjustmentHighlightedIndex - 1));
                        else if (index > 0) {
                          const prev = document.querySelector(
                            `[data-testid="input-adjustment-item-${index - 1}"]`
                          ) as HTMLInputElement;
                          if (prev) prev.focus();
                        }
                      } else if (e.key === "ArrowDown" && !e.shiftKey) {
                        e.preventDefault();
                        if (showAdjustmentSidebar && filteredAdjustmentItems.length > 0)
                          setAdjustmentHighlightedIndex(
                            Math.min(filteredAdjustmentItems.length - 1, adjustmentHighlightedIndex + 1)
                          );
                        else if (index < adjustmentFields.length - 1) {
                          const next = document.querySelector(
                            `[data-testid="input-adjustment-item-${index + 1}"]`
                          ) as HTMLInputElement;
                          if (next) next.focus();
                        }
                      } else if (e.key === "Enter") {
                        e.preventDefault();
                        if (showAdjustmentSidebar && filteredAdjustmentItems.length > 0) {
                          const item = filteredAdjustmentItems[adjustmentHighlightedIndex];
                          if (item) {
                            stockAdjustmentForm.setValue(`entries.${index}.stockItemId`, item.stockItemId);
                            stockAdjustmentForm.setValue(`entries.${index}.stockItemCode`, item.stockItemCode || "");
                            stockAdjustmentForm.setValue(`entries.${index}.stockItemName`, item.stockItemName);
                            stockAdjustmentForm.setValue(`entries.${index}.rate`, item.averageRate || "0");
                            setAdjustmentSearchTerm("");
                            setShowAdjustmentSidebar(false);
                            setTimeout(() => {
                              const qty = document.querySelector(
                                `[data-testid="input-adjustment-qty-${index}"]`
                              ) as HTMLInputElement;
                              if (qty) {
                                qty.focus();
                                qty.select();
                              }
                            }, 50);
                          }
                        }
                      } else if (e.key === "Tab" && !e.shiftKey) {
                        e.preventDefault();
                        setShowAdjustmentSidebar(false);
                        const qty = document.querySelector(
                          `[data-testid="input-adjustment-qty-${index}"]`
                        ) as HTMLInputElement;
                        if (qty) {
                          qty.focus();
                          qty.select();
                        }
                      }
                    }}
                    placeholder="Type to search..."
                    className="w-full h-full px-3 bg-transparent outline-none focus:bg-accent/20"
                    data-testid={`input-adjustment-item-${index}`}
                  />
                </div>
                <div className="w-16 sm:w-20 border-r h-9 sm:h-10 bg-muted/20 flex items-center justify-end px-2 sm:px-3 font-mono text-xs sm:text-sm text-muted-foreground">
                  {formatNumber(parseFloat(availableQty))}
                </div>
                <div className="w-16 sm:w-24 border-r h-9 sm:h-10">
                  <input
                    type="number"
                    step="0.001"
                    value={currentEntry?.quantity || ""}
                    onChange={(e) => stockAdjustmentForm.setValue(`entries.${index}.quantity`, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey)) {
                        e.preventDefault();
                        const rate = document.querySelector(
                          `[data-testid="input-adjustment-rate-${index}"]`
                        ) as HTMLInputElement;
                        if (rate) {
                          rate.focus();
                          rate.select();
                        }
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const next = document.querySelector(
                          `[data-testid="input-adjustment-qty-${index + 1}"]`
                        ) as HTMLInputElement;
                        if (next) next.focus();
                      } else if (e.key === "ArrowUp" && index > 0) {
                        e.preventDefault();
                        const prev = document.querySelector(
                          `[data-testid="input-adjustment-qty-${index - 1}"]`
                        ) as HTMLInputElement;
                        if (prev) prev.focus();
                      }
                    }}
                    placeholder="0"
                    className="w-full h-full px-3 bg-transparent outline-none focus:bg-accent/20 font-mono text-right"
                    data-testid={`input-adjustment-qty-${index}`}
                  />
                </div>
                <div className="w-16 sm:w-24 border-r h-9 sm:h-10">
                  <input
                    type="number"
                    step="0.01"
                    value={currentEntry?.rate || ""}
                    onChange={(e) => stockAdjustmentForm.setValue(`entries.${index}.rate`, e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        if (index === adjustmentFields.length - 1) {
                          appendAdjustment({
                            type: "CONSUME",
                            stockItemId: 0,
                            stockItemCode: "",
                            stockItemName: "",
                            quantity: "",
                            rate: "",
                          });
                          setTimeout(() => {
                            const next = document.querySelector(
                              `[data-testid="input-adjustment-type-${index + 1}"]`
                            ) as HTMLInputElement;
                            if (next) next.focus();
                          }, 100);
                        } else {
                          const next = document.querySelector(
                            `[data-testid="input-adjustment-type-${index + 1}"]`
                          ) as HTMLInputElement;
                          if (next) next.focus();
                        }
                      } else if (e.key === "ArrowDown") {
                        e.preventDefault();
                        const next = document.querySelector(
                          `[data-testid="input-adjustment-rate-${index + 1}"]`
                        ) as HTMLInputElement;
                        if (next) next.focus();
                      } else if (e.key === "ArrowUp" && index > 0) {
                        e.preventDefault();
                        const prev = document.querySelector(
                          `[data-testid="input-adjustment-rate-${index - 1}"]`
                        ) as HTMLInputElement;
                        if (prev) prev.focus();
                      }
                    }}
                    placeholder="0"
                    className="w-full h-full px-3 bg-transparent outline-none focus:bg-accent/20 font-mono text-right"
                    data-testid={`input-adjustment-rate-${index}`}
                  />
                </div>
                <div className="w-20 sm:w-28 border-r h-9 sm:h-10 bg-muted/30 flex items-center justify-end px-2 sm:px-3 font-mono text-xs sm:text-sm">
                  {formatAmount(parseFloat(currentEntry?.quantity || "0") * parseFloat(currentEntry?.rate || "0"))}
                </div>
                <div className="w-10 sm:w-12 flex items-center justify-center h-9 sm:h-10">
                  {adjustmentFields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      onClick={() => removeAdjustment(index)}
                      className="h-8 w-8"
                      data-testid={`button-remove-adjustment-${index}`}
                    >
                      <X className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
