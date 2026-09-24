/**
 * AddPriceLineDialog — extracted from FactoryProformas.tsx during the Phase 4 split.
 *
 * Props are the parent-scope bindings the block referenced; they were
 * discovered from compiler errors rather than guessed.
 */
import type { useFactoryProformasModel } from "../../factoryproformas/useFactoryProformasModel";

type FactoryProformasModel = ReturnType<typeof useFactoryProformasModel>;
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Search, BookOpen, PenLine } from "lucide-react";

export function AddPriceLineDialog({
  addLineMode,
  addLineMutation,
  allStockItems,
  catalogSearch,
  catalogSelectedItem,
  handleAddLine,
  isAddLineOpen,
  newLine,
  priceListMap,
  setAddLineMode,
  setCatalogSearch,
  setCatalogSelectedItem,
  setIsAddLineOpen,
  setNewLine,
}: {
  addLineMode: FactoryProformasModel["addLineMode"];
  addLineMutation: FactoryProformasModel["addLineMutation"];
  allStockItems: FactoryProformasModel["allStockItems"];
  catalogSearch: FactoryProformasModel["catalogSearch"];
  catalogSelectedItem: FactoryProformasModel["catalogSelectedItem"];
  handleAddLine: FactoryProformasModel["handleAddLine"];
  isAddLineOpen: FactoryProformasModel["isAddLineOpen"];
  newLine: FactoryProformasModel["newLine"];
  priceListMap: FactoryProformasModel["priceListMap"];
  setAddLineMode: FactoryProformasModel["setAddLineMode"];
  setCatalogSearch: FactoryProformasModel["setCatalogSearch"];
  setCatalogSelectedItem: FactoryProformasModel["setCatalogSelectedItem"];
  setIsAddLineOpen: FactoryProformasModel["setIsAddLineOpen"];
  setNewLine: FactoryProformasModel["setNewLine"];
}) {
  return (
    <Dialog
      open={isAddLineOpen}
      onOpenChange={(open) => {
        setIsAddLineOpen(open);
        if (!open) {
          setCatalogSelectedItem(null);
          setCatalogSearch("");
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add Price Line</DialogTitle>
        </DialogHeader>

        {/* Mode toggle */}
        <div className="flex rounded-md border overflow-hidden w-full">
          <button
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors ${addLineMode === "catalog" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover-elevate"}`}
            onClick={() => {
              setAddLineMode("catalog");
              setCatalogSelectedItem(null);
              setCatalogSearch("");
              setNewLine({
                articleCode: "",
                productName: "",
                quantity: newLine.quantity,
                pricePerBale: newLine.pricePerBale,
              });
            }}
            data-testid="button-mode-catalog"
          >
            <BookOpen className="h-4 w-4" />
            From Catalog
          </button>
          <button
            className={`flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium transition-colors ${addLineMode === "manual" ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover-elevate"}`}
            onClick={() => {
              setAddLineMode("manual");
              setCatalogSelectedItem(null);
              setNewLine({ articleCode: "", productName: "", quantity: "", pricePerBale: "" });
            }}
            data-testid="button-mode-manual"
          >
            <PenLine className="h-4 w-4" />
            Manual Entry
          </button>
        </div>

        <div className="space-y-4 py-1">
          {addLineMode === "catalog" ? (
            <>
              {/* Item picker */}
              {!catalogSelectedItem ? (
                <div className="space-y-2">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search by name or article code..."
                      value={catalogSearch}
                      onChange={(e) => setCatalogSearch(e.target.value)}
                      className="pl-8"
                      autoFocus
                      data-testid="input-catalog-search"
                    />
                  </div>
                  <div className="border rounded-md overflow-hidden max-h-64 overflow-y-auto">
                    {allStockItems.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">Loading items...</p>
                    ) : (
                      (() => {
                        const q = catalogSearch.toLowerCase().trim();
                        const filtered = q
                          ? allStockItems.filter(
                              (item) => item.name?.toLowerCase().includes(q) || item.code?.toLowerCase().includes(q)
                            )
                          : allStockItems;
                        if (filtered.length === 0)
                          return (
                            <p className="text-sm text-muted-foreground text-center py-6">
                              No items match "{catalogSearch}"
                            </p>
                          );
                        return filtered.map((item) => (
                          <button
                            key={item.id}
                            className="w-full flex items-center justify-between px-3 py-2.5 text-left hover-elevate border-b last:border-b-0"
                            onClick={() => {
                              setCatalogSelectedItem(item);
                              setNewLine((prev) => ({
                                ...prev,
                                articleCode: item.code || "",
                                productName: item.name || "",
                                pricePerBale: item.code && priceListMap[item.code] ? priceListMap[item.code] : "",
                              }));
                            }}
                            data-testid={`button-catalog-item-${item.id}`}
                          >
                            <div>
                              <p className="text-sm font-medium">{item.name}</p>
                              {item.code && <p className="text-xs text-muted-foreground font-mono">{item.code}</p>}
                            </div>
                            <div className="flex items-center gap-2 ml-2 shrink-0">
                              {item.code && priceListMap[item.code] && (
                                <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
                                  ${parseFloat(priceListMap[item.code]).toFixed(2)}
                                </span>
                              )}
                              {item.stockGroup?.name && (
                                <span className="text-xs text-muted-foreground">{item.stockGroup.name}</span>
                              )}
                            </div>
                          </button>
                        ));
                      })()
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">{allStockItems.length} items in catalog</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Selected item chip with change button */}
                  <div className="flex items-center gap-2 p-3 rounded-md bg-muted">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{catalogSelectedItem.name}</p>
                      {catalogSelectedItem.code && (
                        <p className="text-xs text-muted-foreground font-mono">{catalogSelectedItem.code}</p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCatalogSelectedItem(null);
                        setCatalogSearch("");
                        setNewLine((prev) => ({
                          ...prev,
                          articleCode: "",
                          productName: "",
                          quantity: "",
                          pricePerBale: "",
                        }));
                      }}
                      data-testid="button-change-item"
                    >
                      Change
                    </Button>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-medium mb-1 block">Quantity</label>
                      <Input
                        type="number"
                        placeholder="e.g. 10"
                        value={newLine.quantity}
                        onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                        }}
                        autoFocus
                        data-testid="input-line-quantity"
                      />
                    </div>
                    <div>
                      <label className="text-sm font-medium mb-1 block">Price per Bale</label>
                      <Input
                        type="number"
                        step="0.01"
                        placeholder="e.g. 45.00"
                        value={newLine.pricePerBale}
                        onChange={(e) => setNewLine({ ...newLine, pricePerBale: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                        }}
                        data-testid="input-line-price"
                      />
                      {catalogSelectedItem?.code && priceListMap[catalogSelectedItem.code] && (
                        <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
                          Auto-filled from price list — you can override
                        </p>
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          ) : (
            /* Manual mode — existing form */
            <>
              <div>
                <label className="text-sm font-medium mb-1 block">Article Code</label>
                <Input
                  placeholder="e.g. 101"
                  value={newLine.articleCode}
                  onChange={(e) => setNewLine({ ...newLine, articleCode: e.target.value })}
                  data-testid="input-line-article-code"
                />
              </div>
              <div>
                <label className="text-sm font-medium mb-1 block">Product Name</label>
                <Input
                  placeholder="e.g. Mixed Cotton"
                  value={newLine.productName}
                  onChange={(e) => setNewLine({ ...newLine, productName: e.target.value })}
                  data-testid="input-line-product-name"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1 block">Quantity</label>
                  <Input
                    type="number"
                    value={newLine.quantity}
                    onChange={(e) => setNewLine({ ...newLine, quantity: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    }}
                    data-testid="input-line-quantity"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium mb-1 block">Price per Bale</label>
                  <Input
                    type="number"
                    step="0.01"
                    value={newLine.pricePerBale}
                    onChange={(e) => setNewLine({ ...newLine, pricePerBale: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
                    }}
                    data-testid="input-line-price"
                  />
                </div>
              </div>
            </>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <Button variant="outline" onClick={() => setIsAddLineOpen(false)} data-testid="button-cancel-add-line">
              Cancel
            </Button>
            <Button
              onClick={handleAddLine}
              disabled={
                !newLine.articleCode ||
                !newLine.productName ||
                !newLine.quantity ||
                !newLine.pricePerBale ||
                addLineMutation.isPending ||
                (addLineMode === "catalog" && !catalogSelectedItem)
              }
              data-testid="button-confirm-add-line"
            >
              {addLineMutation.isPending ? "Adding..." : "Add Line"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
