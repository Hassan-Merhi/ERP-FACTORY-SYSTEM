// Extracted from ./SilentProductionDialogSection.tsx
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SearchField } from "@/components/ui/search-field";
import { Label } from "@/components/ui/label";
import { X } from "lucide-react";
import { useSilentProductionDialogState } from "./useSilentProductionDialogState";

export function SilentProductionDialogSectionContent({
  allStockItems,
  setSilentProdItems,
  setSilentProdSearchTerm,
  silentLocInventory,
  silentLocInventoryLoading,
  silentProdItems,
  silentProdLocId,
  silentProdSearchTerm,
  silentProdType,
}: Pick<
  Pick<
    ReturnType<typeof useSilentProductionDialogState>,
    | "allStockItems"
    | "setSilentProdApplying"
    | "setSilentProdDone"
    | "setSilentProdItems"
    | "setSilentProdOpen"
    | "setSilentProdSearchTerm"
    | "setSilentProdType"
    | "silentLocInventory"
    | "silentLocInventoryLoading"
    | "silentProdApplying"
    | "silentProdItems"
    | "silentProdLocId"
    | "silentProdSearchTerm"
    | "silentProdType"
  >,
  | "allStockItems"
  | "setSilentProdItems"
  | "setSilentProdSearchTerm"
  | "silentLocInventory"
  | "silentLocInventoryLoading"
  | "silentProdItems"
  | "silentProdLocId"
  | "silentProdSearchTerm"
  | "silentProdType"
>) {
  return (
    <div className="space-y-2">
      <Label>Items</Label>
      {silentProdLocId && (
        <div className="border rounded-md p-3 bg-muted/30 space-y-2">
          <SearchField
            placeholder="Type item name or code to search…"
            value={silentProdSearchTerm}
            onValueChange={setSilentProdSearchTerm}
            data-testid="input-silent-prod-search"
          />
          <div className="max-h-48 overflow-y-auto space-y-1">
            {(() => {
              const term = silentProdSearchTerm.toLowerCase();
              if (!term) {
                return (
                  <div className="text-center text-sm text-muted-foreground py-4">
                    {silentLocInventoryLoading ? "Loading items…" : "Type above to search items at this location"}
                  </div>
                );
              }
              const filtered = allStockItems.filter(
                (stockItem) =>
                  stockItem.name.toLowerCase().includes(term) ||
                  (stockItem.code && stockItem.code.toLowerCase().includes(term))
              );
              if (filtered.length === 0) {
                return <div className="text-center text-sm text-muted-foreground py-4">No items found</div>;
              }
              return filtered.map((stockItem) => {
                const locationRow = silentLocInventory.find((inventory) => inventory.stockItemId === stockItem.id);
                const currentQty = locationRow ? parseFloat(locationRow.quantity || "0") : 0;
                return (
                  <button
                    key={stockItem.id}
                    className="w-full text-left px-2 py-1.5 rounded-md hover-elevate active-elevate-2 flex items-center justify-between gap-2"
                    onClick={() => {
                      const existingIndex = silentProdItems.findIndex(
                        (row) => String(row.stockItemId) === String(stockItem.id)
                      );
                      if (existingIndex < 0) {
                        setSilentProdItems((previous) => [
                          ...previous,
                          {
                            stockItemId: String(stockItem.id),
                            stockItemName: stockItem.name,
                            quantity: "",
                            rate: "",
                            currentQty,
                          },
                        ]);
                      }
                      setSilentProdSearchTerm("");
                    }}
                    data-testid={`button-silent-prod-search-item-${stockItem.id}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{stockItem.name}</div>
                      {stockItem.code && (
                        <div className="text-xs text-muted-foreground font-mono">{stockItem.code}</div>
                      )}
                    </div>
                    <div
                      className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        currentQty === 0
                          ? "bg-destructive/10 text-destructive"
                          : currentQty < 10
                            ? "bg-chart-3/10 text-chart-3"
                            : "bg-chart-2/10 text-chart-2"
                      }`}
                    >
                      {currentQty.toFixed(0)}
                    </div>
                  </button>
                );
              });
            })()}
          </div>
        </div>
      )}

      <div className="space-y-2">
        {silentProdItems.map((item, index) => {
          const quantity = parseFloat(item.quantity || "0") || 0;
          const delta = silentProdType === "Production" ? quantity : -quantity;
          const newQty = (item.currentQty || 0) + delta;
          return (
            <div key={index} className="grid grid-cols-12 gap-2 items-center">
              <div className="col-span-5">
                <Input
                  readOnly
                  value={item.stockItemName || "Search above and click an item"}
                  placeholder="Search above and click an item"
                  className="w-full"
                  data-testid={`input-silent-prod-item-${index}`}
                />
              </div>
              <div className="col-span-2">
                <div
                  className="text-right text-sm text-muted-foreground font-mono"
                  data-testid={`text-current-qty-${index}`}
                >
                  {item.stockItemId ? (item.currentQty || 0).toFixed(0) : "-"}
                </div>
                <div className="text-right text-xs text-muted-foreground">Current</div>
              </div>
              <div className="col-span-2">
                <Input
                  type="number"
                  min="0.001"
                  step="0.001"
                  placeholder={silentProdType === "Production" ? "+Qty" : "−Qty"}
                  value={item.quantity}
                  onChange={(event) =>
                    setSilentProdItems((previous) =>
                      previous.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, quantity: event.target.value } : row
                      )
                    )
                  }
                  data-testid={`input-silent-prod-qty-${index}`}
                  className="text-right"
                />
              </div>
              <div className="col-span-2">
                <div
                  className={`text-right text-sm font-mono font-semibold ${
                    newQty < 0 ? "text-destructive" : "text-foreground"
                  }`}
                  data-testid={`text-new-qty-${index}`}
                >
                  {item.stockItemId && item.quantity ? newQty.toFixed(0) : "-"}
                </div>
                <div className="text-right text-xs text-muted-foreground">New</div>
              </div>
              <div className="col-span-1 flex justify-center">
                <Button
                  size="icon"
                  variant="ghost"
                  onClick={() => setSilentProdItems((previous) => previous.filter((_, i) => i !== index))}
                  disabled={silentProdItems.length === 1}
                  data-testid={`button-remove-prod-row-${index}`}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {silentProdType === "Production" && silentProdItems.some((row) => row.stockItemId) && (
        <div className="space-y-1">
          {silentProdItems.map(
            (item, index) =>
              item.stockItemId && (
                <div key={index} className="grid grid-cols-12 gap-2 items-center">
                  <div
                    className="col-span-5 text-sm text-muted-foreground truncate"
                    data-testid={`text-rate-item-${index}`}
                  >
                    {item.stockItemName}
                  </div>
                  <div className="col-span-3 col-start-6">
                    <Input
                      type="number"
                      placeholder="Rate"
                      value={item.rate}
                      onChange={(event) =>
                        setSilentProdItems((previous) =>
                          previous.map((row, rowIndex) =>
                            rowIndex === index ? { ...row, rate: event.target.value } : row
                          )
                        )
                      }
                      data-testid={`input-silent-prod-rate-${index}`}
                    />
                  </div>
                </div>
              )
          )}
        </div>
      )}

      <Button
        variant="outline"
        size="sm"
        onClick={() =>
          setSilentProdItems((previous) => [
            ...previous,
            { stockItemId: "", stockItemName: "", quantity: "", rate: "", currentQty: 0 },
          ])
        }
        data-testid="button-add-prod-row"
      >
        Add Item
      </Button>
    </div>
  );
}
