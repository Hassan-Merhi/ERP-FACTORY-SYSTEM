import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferMobileEntries({ model }: { model: StockTransferFormModel }) {
  const {
    transferFields,
    transferEntries,
    activeTransferRow,
    activeFieldType,
    transferInventory,
    transferSearchTerm,
    transferSourceSearchTerm,
    removeTransfer,
    isPOS,
    setTransferSourceSearchTerm,
    setTransferSourceHighlightedIndex,
    transferFocusIdRef,
    setActiveTransferRow,
    setActiveFieldType,
    setShowSourceSidebar,
    setShowItemSidebar,
    stockTransferForm,
    setTransferInventorySource,
    setTransferSearchTerm,
    setTransferHighlightedIndex,
    posSelectedSourceId,
    locations,
    transferInventorySource,
    transferQtyDraft,
    setTransferQtyDraft,
    voucherIdToEdit,
    stockTransferToEdit,
    formatAmount,
    appendTransfer,
    transferTotal,
  } = model;

  return (
    <div className="sm:hidden p-3 space-y-2">
      {transferFields.map((field, index) => {
        const entry = transferEntries[index];
        const mobileFilteredItems =
          activeTransferRow === index && activeFieldType === "item"
            ? transferInventory
                .filter((item) => {
                  if (!transferSearchTerm.trim()) return true;
                  const term = transferSearchTerm.toLowerCase();
                  return (
                    item.stockItemName?.toLowerCase().includes(term) || item.stockItemCode?.toLowerCase().includes(term)
                  );
                })
                .sort((a, b) => (a.stockItemName || "").localeCompare(b.stockItemName || ""))
                .slice(0, 10)
            : [];
        const mobileFilteredLocs =
          activeTransferRow === index && activeFieldType === "source"
            ? locations
                .filter((loc) => {
                  if (!transferSourceSearchTerm.trim()) return true;
                  const term = transferSourceSearchTerm.toLowerCase();
                  return (loc.name || "").toLowerCase().includes(term);
                })
                .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                .slice(0, 8)
            : [];
        return (
          <div key={field.id} className="border rounded-md p-3 space-y-2 bg-card">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground font-medium">#{index + 1}</span>
              {transferFields.length > 1 && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  onClick={() => removeTransfer(index)}
                  className="h-7 w-7"
                  data-testid={`button-remove-transfer-mobile-${index}`}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
            {!isPOS && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Source</label>
                <input
                  type="text"
                  value={
                    activeTransferRow === index && activeFieldType === "source"
                      ? transferSourceSearchTerm
                      : entry?.sourceLocationName || ""
                  }
                  onChange={(e) => {
                    setTransferSourceSearchTerm(e.target.value);
                    setTransferSourceHighlightedIndex(0);
                  }}
                  onFocus={() => {
                    transferFocusIdRef.current += 1;
                    setActiveTransferRow(index);
                    setActiveFieldType("source");
                    setTransferSourceSearchTerm(entry?.sourceLocationName || "");
                    setTransferSourceHighlightedIndex(0);
                    setShowSourceSidebar(true);
                    setShowItemSidebar(false);
                  }}
                  onBlur={() => {
                    const focusId = transferFocusIdRef.current;
                    setTimeout(() => {
                      if (transferFocusIdRef.current === focusId) {
                        setActiveTransferRow(null);
                        setActiveFieldType(null);
                        setTransferSourceSearchTerm("");
                        setShowSourceSidebar(false);
                      }
                    }, 250);
                  }}
                  placeholder="Type location..."
                  data-testid={`input-source-mobile-${index}`}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring"
                />
                {mobileFilteredLocs.length > 0 && (
                  <div className="border rounded-md bg-popover shadow-md max-h-36 overflow-y-auto z-20 relative">
                    {mobileFilteredLocs.map((loc) => (
                      <button
                        key={loc.id}
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover-elevate border-b last:border-b-0"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          stockTransferForm.setValue(`entries.${index}.sourceLocationId`, loc.id);
                          stockTransferForm.setValue(`entries.${index}.sourceLocationName`, loc.name);
                          setTransferInventorySource(loc.id);
                          setTransferSourceSearchTerm("");
                          setShowSourceSidebar(false);
                        }}
                      >
                        {loc.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Item</label>
              <input
                type="text"
                value={
                  activeTransferRow === index && activeFieldType === "item"
                    ? transferSearchTerm
                    : entry?.stockItemName || ""
                }
                onChange={(e) => {
                  setTransferSearchTerm(e.target.value);
                  setTransferHighlightedIndex(0);
                  if (!e.target.value) {
                    stockTransferForm.setValue(`entries.${index}.stockItemId`, 0);
                    stockTransferForm.setValue(`entries.${index}.stockItemCode`, "");
                    stockTransferForm.setValue(`entries.${index}.stockItemName`, "");
                  }
                }}
                onFocus={() => {
                  transferFocusIdRef.current += 1;
                  setActiveTransferRow(index);
                  setActiveFieldType("item");
                  setTransferHighlightedIndex(0);
                  setTransferSearchTerm(entry?.stockItemName || "");
                  setShowItemSidebar(true);
                  setShowSourceSidebar(false);
                  if (entry?.sourceLocationId > 0) setTransferInventorySource(entry.sourceLocationId);
                  else if (isPOS && posSelectedSourceId) setTransferInventorySource(posSelectedSourceId);
                }}
                onBlur={() => {
                  const focusId = transferFocusIdRef.current;
                  setTimeout(() => {
                    if (transferFocusIdRef.current === focusId) {
                      setActiveTransferRow(null);
                      setActiveFieldType(null);
                      setTransferSearchTerm("");
                      setShowItemSidebar(false);
                    }
                  }, 200);
                }}
                placeholder="Type to search item..."
                data-testid={`input-item-name-mobile-${index}`}
                className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring"
              />
              {mobileFilteredItems.length > 0 && (
                <div className="border rounded-md bg-popover shadow-md max-h-40 overflow-y-auto z-20 relative">
                  {mobileFilteredItems.map((item) => (
                    <button
                      key={item.stockItemId}
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover-elevate border-b last:border-b-0"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        const sourceId = Number(transferInventorySource);
                        if (!(sourceId > 0)) return;
                        const sourceLocation = locations.find((l) => l.id === sourceId);
                        stockTransferForm.setValue(`entries.${index}.sourceLocationId`, sourceId, {
                          shouldValidate: true,
                        });
                        stockTransferForm.setValue(`entries.${index}.sourceLocationName`, sourceLocation?.name || "");
                        stockTransferForm.setValue(`entries.${index}.stockItemId`, item.stockItemId, {
                          shouldValidate: true,
                        });
                        stockTransferForm.setValue(`entries.${index}.stockItemCode`, item.stockItemCode || "");
                        stockTransferForm.setValue(`entries.${index}.stockItemName`, item.stockItemName);
                        stockTransferForm.setValue(`entries.${index}.rate`, item.averageRate || "0");
                        setTransferSearchTerm("");
                        setShowItemSidebar(false);
                      }}
                    >
                      <div className="font-medium truncate">{item.stockItemName}</div>
                      <div className="text-xs text-muted-foreground">Qty: {formatNumber(typeof item.quantity === "number" ? item.quantity : undefined, 0)}</div>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Qty</label>
                <input
                  type="text"
                  inputMode="decimal"
                  value={
                    transferQtyDraft[`m${index}`] !== undefined ? transferQtyDraft[`m${index}`] : entry?.quantity || ""
                  }
                  onFocus={() => setTransferQtyDraft((prev) => ({ ...prev, [`m${index}`]: entry?.quantity || "" }))}
                  onChange={(e) => {
                    const raw = e.target.value;
                    setTransferQtyDraft((prev) => ({ ...prev, [`m${index}`]: raw }));
                    if (!raw.startsWith("+") && !raw.startsWith("-")) {
                      stockTransferForm.setValue(`entries.${index}.quantity`, raw);
                    }
                  }}
                  onBlur={() => {
                    const raw = (transferQtyDraft[`m${index}`] ?? "").trim();
                    setTransferQtyDraft((prev) => {
                      const n = { ...prev };
                      delete n[`m${index}`];
                      return n;
                    });
                    const delta = parseFloat(raw.startsWith("+") ? raw.slice(1) : raw);
                    if (isNaN(delta)) return;
                    if (voucherIdToEdit && stockTransferToEdit?.items) {
                      const origItem = (
                        stockTransferToEdit.items as {
                          stockItemId: number;
                          sourceLocationId: number;
                          quantity: string;
                        }[]
                      ).find(
                        (item) =>
                          item.stockItemId === entry.stockItemId && item.sourceLocationId === entry.sourceLocationId
                      );
                      const origQty = origItem ? parseFloat(origItem.quantity) || 0 : 0;
                      stockTransferForm.setValue(`entries.${index}.quantity`, Math.max(0, origQty + delta).toString());
                    } else {
                      stockTransferForm.setValue(`entries.${index}.quantity`, Math.max(0, delta).toString());
                    }
                  }}
                  placeholder={voucherIdToEdit ? "-1 to reduce, 2 to add" : "0"}
                  data-testid={`input-transfer-quantity-mobile-${index}`}
                  className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring font-mono text-right"
                />
              </div>
              {!isPOS && (
                <div className="space-y-1">
                  <label className="text-xs text-muted-foreground">Rate</label>
                  <input
                    type="number"
                    step="0.01"
                    value={entry?.rate || ""}
                    onChange={(e) => stockTransferForm.setValue(`entries.${index}.rate`, e.target.value)}
                    placeholder="0.00"
                    data-testid={`input-transfer-rate-mobile-${index}`}
                    className="w-full px-3 py-2 text-sm border rounded-md bg-background outline-none focus:ring-1 focus:ring-ring font-mono text-right"
                  />
                </div>
              )}
            </div>
            {!isPOS && (
              <div className="flex items-center justify-between px-1">
                <span className="text-xs text-muted-foreground">Amount</span>
                <span className="text-sm font-mono font-medium">
                  {formatAmount(parseFloat(entry?.quantity || "0") * parseFloat(entry?.rate || "0"))}
                </span>
              </div>
            )}
          </div>
        );
      })}
      <div className="flex items-center justify-between pt-1 px-0.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            appendTransfer({
              sourceLocationId: 0,
              sourceLocationName: "",
              stockItemId: 0,
              stockItemCode: "",
              stockItemName: "",
              quantity: "",
              rate: "",
            })
          }
          data-testid="button-add-transfer-row-mobile"
        >
          <Plus className="h-4 w-4 mr-2" />
          Add Row
        </Button>
        {!isPOS && <div className="font-bold font-mono text-sm">Total: {formatAmount(transferTotal)}</div>}
      </div>
    </div>
  );
}
