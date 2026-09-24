import { searchAny } from "@shared/searchNormalization";
import { Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferSidebars({ model }: { model: StockTransferFormModel }) {
  const {
    showItemSidebar,
    setShowItemSidebar,
    transferInventorySource,
    locations,
    transferSearchTerm,
    setTransferSearchTerm,
    setTransferHighlightedIndex,
    transferSidebarRef,
    filteredTransferInventory,
    transferHighlightedIndex,
    activeTransferRow,
    stockItems,
    toast,
    stockTransferForm,
    showSourceSidebar,
    isPOS,
    setShowSourceSidebar,
    transferSourceSearchTerm,
    setTransferSourceSearchTerm,
    setTransferSourceHighlightedIndex,
    transferSourceHighlightedIndex,
    transferFocusIdRef,
    setTransferInventorySource,
    setActiveTransferRow,
    setActiveFieldType,
  } = model;

  return (
    <>
      {showItemSidebar && (
        <Card className="hidden sm:flex flex-col w-full lg:w-80 lg:sticky lg:top-4 max-h-[60vh] lg:max-h-[calc(100vh-12rem)] self-start">
          <div className="p-4 border-b">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold">Search Items</h3>
              <button
                onClick={() => setShowItemSidebar(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-close-item-sidebar"
              >
                ✕
              </button>
            </div>
            {transferInventorySource && (
              <p className="text-xs text-muted-foreground mb-3">
                {locations.find((location) => location.id === transferInventorySource)?.name}
              </p>
            )}
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name or code..."
                value={transferSearchTerm}
                onChange={(event) => {
                  setTransferSearchTerm(event.target.value);
                  setTransferHighlightedIndex(0);
                }}
                className="pl-9"
                data-testid="input-transfer-sidebar-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2" ref={transferSidebarRef}>
            <div className="space-y-1">
              {!transferInventorySource ? (
                <div className="text-center py-8 text-sm text-muted-foreground">
                  Select a source location to see available items
                </div>
              ) : filteredTransferInventory.length === 0 ? (
                <div className="text-center py-8 text-sm text-muted-foreground">No items found</div>
              ) : (
                filteredTransferInventory.map((item, index: number) => {
                  const stock = parseFloat(item.quantity || "0");
                  const isHighlighted = index === transferHighlightedIndex && activeTransferRow !== null;
                  return (
                    <button
                      key={item.stockItemId}
                      type="button"
                      data-transfer-idx={index}
                      className={`w-full text-left px-3 py-3 rounded-md hover-elevate active-elevate-2 ${stock === 0 ? "opacity-60" : ""} ${isHighlighted ? "bg-accent" : ""}`}
                      data-testid={`button-suggest-item-${item.stockItemId}`}
                      onClick={() => {
                        if (activeTransferRow === null) return;
                        const stockItem = stockItems.find((candidate) => candidate.id === item.stockItemId);
                        if (!stockItem) return;
                        const sourceId = Number(transferInventorySource);
                        if (!(sourceId > 0)) {
                          toast({
                            title: "Select a source location first",
                            description:
                              "Please select a source location from the inventory sidebar before adding items.",
                            variant: "destructive",
                          });
                          return;
                        }
                        const sourceLocation = locations.find((location) => location.id === sourceId);
                        stockTransferForm.setValue(`entries.${activeTransferRow}.sourceLocationId`, sourceId, {
                          shouldValidate: true,
                          shouldDirty: true,
                          shouldTouch: true,
                        });
                        stockTransferForm.setValue(
                          `entries.${activeTransferRow}.sourceLocationName`,
                          sourceLocation?.name || ""
                        );
                        stockTransferForm.setValue(`entries.${activeTransferRow}.stockItemId`, item.stockItemId, {
                          shouldValidate: true,
                          shouldDirty: true,
                          shouldTouch: true,
                        });
                        stockTransferForm.setValue(`entries.${activeTransferRow}.stockItemCode`, stockItem.code || "");
                        stockTransferForm.setValue(`entries.${activeTransferRow}.stockItemName`, stockItem.name);
                        stockTransferForm.setValue(`entries.${activeTransferRow}.rate`, item.averageRate || "0");
                        setTransferSearchTerm("");
                        setTimeout(() => {
                          const quantity = document.querySelector(
                            `[data-testid="input-transfer-quantity-${activeTransferRow}"]`
                          ) as HTMLInputElement;
                          if (quantity) {
                            quantity.focus();
                            quantity.select();
                          }
                        }, 50);
                      }}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium mb-1 truncate">{item.stockItemName}</div>
                        </div>
                        <div className="flex items-center">
                          <div
                            className={`text-xs font-medium px-2 py-0.5 rounded ${stock === 0 ? "bg-destructive/10 text-destructive" : stock < 10 ? "bg-chart-3/10 text-chart-3" : "bg-chart-2/10 text-chart-2"}`}
                          >
                            {stock === 0 ? "Out" : `${stock.toFixed(0)}`}
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
      )}

      {!isPOS && showSourceSidebar && (
        <Card className="hidden sm:flex flex-col w-full lg:w-80 lg:sticky lg:top-4 max-h-[60vh] lg:max-h-[calc(100vh-12rem)] self-start">
          <div className="p-4 border-b">
            <div className="flex items-center justify-between gap-2 mb-2">
              <h3 className="text-sm font-semibold">Select Source</h3>
              <button
                onClick={() => setShowSourceSidebar(false)}
                className="text-xs text-muted-foreground hover:text-foreground"
                data-testid="button-close-source-sidebar"
              >
                ✕
              </button>
            </div>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search locations..."
                value={transferSourceSearchTerm}
                onChange={(event) => {
                  setTransferSourceSearchTerm(event.target.value);
                  setTransferSourceHighlightedIndex(0);
                }}
                className="pl-9"
                data-testid="input-transfer-source-search"
              />
            </div>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <div className="space-y-1">
              {(() => {
                const filteredLocations = locations
                  .filter((location) => {
                    if (!transferSourceSearchTerm.trim()) return true;
                    return searchAny(transferSourceSearchTerm, location.name, location.code);
                  })
                  .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
                if (filteredLocations.length === 0)
                  return <div className="text-center py-8 text-sm text-muted-foreground">No locations found</div>;
                return filteredLocations.map((location, index) => {
                  const isHighlighted = index === transferSourceHighlightedIndex && activeTransferRow !== null;
                  return (
                    <button
                      key={location.id}
                      type="button"
                      className={`w-full text-left px-3 py-3 rounded-md hover-elevate active-elevate-2 ${isHighlighted ? "bg-accent" : ""}`}
                      data-testid={`button-select-source-location-${location.id}`}
                      onMouseDown={(event) => {
                        event.preventDefault();
                        transferFocusIdRef.current += 1;
                      }}
                      onClick={() => {
                        if (activeTransferRow === null) return;
                        const rowIndex = activeTransferRow;
                        stockTransferForm.setValue(`entries.${rowIndex}.sourceLocationId`, location.id);
                        stockTransferForm.setValue(`entries.${rowIndex}.sourceLocationName`, location.name);
                        setTransferInventorySource(location.id);
                        setTransferSourceSearchTerm("");
                        setShowSourceSidebar(false);
                        setActiveTransferRow(null);
                        setActiveFieldType(null);
                        setTimeout(() => {
                          const item = document.querySelector(
                            `[data-testid="input-item-name-${rowIndex}"]`
                          ) as HTMLInputElement;
                          if (item) {
                            item.focus();
                            item.select();
                          }
                        }, 50);
                      }}
                    >
                      <div className="text-sm font-medium">{location.name}</div>
                    </button>
                  );
                });
              })()}
            </div>
          </div>
        </Card>
      )}
    </>
  );
}
