/**
 * Desktop product browser panel for the Factory POS page.
 *
 * Split out of FactoryPOS.tsx unchanged: the search input keeps autofocus and
 * the ↑↓/Enter/Escape handling used for barcode scanning, and items are still
 * added on mouseDown so focus never leaves the search box.
 */
import { Check, Package, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatNum } from "./utils";
import type { FactoryPosModel } from "./useFactoryPosModel";

export function FactoryPosProductBrowser({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, filteredInventory } = model;
  return (
    <Card className="hidden lg:flex w-96 flex-col sticky top-4 max-h-[calc(100vh-8rem)] self-start">
      <div className="p-4 border-b">
        <h3 className="text-sm font-medium mb-2">Products</h3>
        <p className="text-xs text-muted-foreground mb-3">Type or scan a barcode — ↑↓ to navigate, Enter to add</p>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            ref={model.searchRef}
            placeholder="Scan barcode or search..."
            value={model.search}
            onChange={(e) => {
              model.setSearch(e.target.value);
              model.setHighlightedIndex(0);
            }}
            onKeyDown={model.handleSearchKeyDown}
            className="pl-9"
            autoFocus
            data-testid="input-product-search"
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto p-3">
        {!model.locationId ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-muted-foreground">
            <Package className="h-8 w-8 opacity-40" />
            <span className="text-sm">Select a location first</span>
          </div>
        ) : model.invLoading ? (
          <div className="text-center text-muted-foreground text-sm py-8">Loading inventory...</div>
        ) : filteredInventory.length === 0 ? (
          <div className="text-center text-muted-foreground text-sm py-8">No products in stock</div>
        ) : (
          <div className="space-y-1" ref={model.itemListRef}>
            {filteredInventory.map((item, idx) => {
              const inCart = model.rows.find((r) => r.productId === item.productId);
              const price = parseFloat(item.sellingPrice || "0");
              const isHighlighted = idx === model.highlightedIndex;
              return (
                <button
                  key={item.productId}
                  onMouseDown={(e) => {
                    // Use mouseDown so focus stays on the search input while clicking
                    e.preventDefault();
                    model.addProductFromSearch(item);
                  }}
                  onMouseEnter={() => model.setHighlightedIndex(idx)}
                  className={`w-full text-left rounded-md px-3 py-2.5 border flex items-center justify-between gap-2 transition-colors ${
                    isHighlighted ? "bg-accent border-accent-foreground/20" : "hover-elevate active-elevate-2"
                  }`}
                  data-testid={`card-product-${item.productId}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{item.productName}</div>
                    <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                      {item.articleCode && <span className="font-mono">{item.articleCode}</span>}
                      <span>Stock: {item.quantity}</span>
                      {price > 0 && (
                        <span className="font-semibold">
                          {ccPrefix}
                          {formatNum(price)}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 flex items-center gap-1.5">
                    {inCart && (
                      <Badge variant="outline" className="text-xs">
                        ×{inCart.quantity}
                      </Badge>
                    )}
                    {isHighlighted ? (
                      <Check className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Plus className="h-4 w-4 text-muted-foreground" />
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Card>
  );
}
