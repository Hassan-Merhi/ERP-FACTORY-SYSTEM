// Extracted from ./PurchaseOrderEdit.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { formatCurrency } from "@/lib/formatNumber";
import { focusScopedTestId } from "@/lib/scopedFocus";
import { usePurchaseOrderEditState } from "./usePurchaseOrderEditState";

export function PurchaseOrderEditSection({
  activeRow,
  containerRef,
  filteredStockItems,
  focusIdRef,
  handleAddItem,
  handleItemChange,
  handleRemoveItem,
  handleSelectItem,
  highlightedIndex,
  items,
  itemsTotal,
  lineTotals,
  priceSymbol,
  searchTerm,
  setActiveRow,
  setHighlightedIndex,
  setSearchTerm,
  setShowItemSidebar,
  setSidebarTop,
  showItemSidebar,
  totalQuantity,
}: Pick<
  ReturnType<typeof usePurchaseOrderEditState>,
  | "activeRow"
  | "containerRef"
  | "filteredStockItems"
  | "focusIdRef"
  | "handleAddItem"
  | "handleItemChange"
  | "handleRemoveItem"
  | "handleSelectItem"
  | "highlightedIndex"
  | "items"
  | "itemsTotal"
  | "lineTotals"
  | "priceSymbol"
  | "searchTerm"
  | "setActiveRow"
  | "setHighlightedIndex"
  | "setSearchTerm"
  | "setShowItemSidebar"
  | "setSidebarTop"
  | "showItemSidebar"
  | "totalQuantity"
>) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>Line Items</Label>
        <Button size="sm" variant="outline" onClick={handleAddItem} data-testid="button-add-item">
          <Plus className="h-4 w-4 mr-1" />
          Add Item
        </Button>
      </div>

      <div className="border rounded-md overflow-x-auto">
        <Table>
          <TableHeader className="sticky top-0 z-30 bg-background">
            <TableRow>
              <TableHead className="w-[40%]">Item</TableHead>
              <TableHead className="text-right">Quantity</TableHead>
              <TableHead className="text-right">Rate</TableHead>
              <TableHead className="text-right">Line Total</TableHead>
              <TableHead className="w-12"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((item, index) => (
              <TableRow key={item.id || `new-${index}`} data-testid={`row-item-${index}`}>
                <TableCell>
                  <input
                    type="text"
                    value={activeRow === index ? searchTerm : item.itemName || ""}
                    onChange={(event) => {
                      setSearchTerm(event.target.value);
                      setHighlightedIndex(0);
                    }}
                    onFocus={(event) => {
                      focusIdRef.current += 1;
                      setActiveRow(index);
                      setSearchTerm(item.itemName || "");
                      setHighlightedIndex(0);
                      setShowItemSidebar(true);
                      const row = event.currentTarget.closest("tr");
                      const container = containerRef.current;
                      if (row && container) {
                        const rowRect = row.getBoundingClientRect();
                        const containerRect = container.getBoundingClientRect();
                        setSidebarTop(rowRect.top - containerRect.top);
                      }
                    }}
                    onBlur={() => {
                      const focusIdAtBlur = focusIdRef.current;
                      setTimeout(() => {
                        if (focusIdRef.current === focusIdAtBlur) {
                          setActiveRow(null);
                          setSearchTerm("");
                          setShowItemSidebar(false);
                        }
                      }, 200);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") {
                        if (showItemSidebar && filteredStockItems.length > 0) {
                          event.preventDefault();
                          setHighlightedIndex(Math.min(filteredStockItems.length - 1, highlightedIndex + 1));
                        }
                      } else if (event.key === "ArrowUp") {
                        if (showItemSidebar && filteredStockItems.length > 0) {
                          event.preventDefault();
                          setHighlightedIndex(Math.max(0, highlightedIndex - 1));
                        }
                      } else if (event.key === "Enter") {
                        event.preventDefault();
                        event.stopPropagation();
                        if (showItemSidebar && filteredStockItems.length > 0) {
                          handleSelectItem(filteredStockItems[highlightedIndex]);
                        }
                      } else if (event.key === "Tab" && !event.shiftKey) {
                        if (index + 1 < items.length) {
                          event.preventDefault();
                          focusScopedTestId(`input-item-name-${index + 1}`, {
                            anchor: event.currentTarget,
                          });
                        } else {
                          setShowItemSidebar(false);
                          setSearchTerm("");
                        }
                      }
                    }}
                    placeholder="Type to search..."
                    className="w-full h-9 px-3 rounded-md border bg-background outline-hidden focus:ring-2 focus:ring-ring"
                    data-testid={`input-item-name-${index}`}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="0.01"
                    value={item.quantity}
                    onChange={(event) => handleItemChange(index, "quantity", event.target.value)}
                    className="text-right"
                    data-testid={`input-quantity-${index}`}
                  />
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="0.01"
                    value={item.rate}
                    onChange={(event) => handleItemChange(index, "rate", event.target.value)}
                    className="text-right"
                    data-testid={`input-rate-${index}`}
                  />
                </TableCell>
                <TableCell className="text-right font-mono">
                  {priceSymbol}
                  {formatCurrency(parseFloat(lineTotals[index] || "0"))}
                </TableCell>
                <TableCell>
                  <Button
                    size="icon"
                    variant="ghost"
                    onClick={() => handleRemoveItem(index)}
                    data-testid={`button-remove-item-${index}`}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  No items. Click "Add Item" to add line items.
                </TableCell>
              </TableRow>
            )}
            {items.length > 0 && (
              <TableRow className="bg-muted/50">
                <TableCell className="text-right font-medium">Total:</TableCell>
                <TableCell className="text-right font-mono font-bold">{formatCurrency(totalQuantity)}</TableCell>
                <TableCell></TableCell>
                <TableCell className="text-right font-mono font-bold">
                  {priceSymbol}
                  {formatCurrency(parseFloat(itemsTotal))}
                </TableCell>
                <TableCell></TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
