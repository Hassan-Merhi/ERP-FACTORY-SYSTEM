/**
 * Desktop product browser panel for the Factory POS page.
 *
 * Split out of FactoryPOS.tsx unchanged: the search input keeps autofocus and
 * the ↑↓/Enter/Escape handling used for barcode scanning, and items are still
 * added on mouseDown so focus never leaves the search box.
 */
import { Check, NotepadText, Package, Plus, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { MobileBarcodeScanner } from "@/components/MobileBarcodeScanner";
import { formatNum } from "./utils";
import type { FactoryPosModel } from "./useFactoryPosModel";

export function FactoryPosProductBrowser({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, filteredInventory } = model;
  return (
    <div className="sticky top-4 flex w-full flex-col gap-3 self-start lg:w-96">
      <Card className="rounded-2xl border-border/70 p-4 shadow-sm">
        <label htmlFor="factory-pos-desktop-notes" className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <NotepadText className="h-4 w-4 text-orange-500" aria-hidden="true" />
          Notes (optional)
        </label>
        <Textarea
          id="factory-pos-desktop-notes"
          placeholder="Notes (optional)"
          value={model.notes}
          onChange={(e) => model.setNotes(e.target.value)}
          className="min-h-20 resize-y rounded-xl border-border/70 bg-background/60"
          data-testid="input-notes"
        />
      </Card>
      <Card className="flex min-h-[280px] flex-col overflow-hidden rounded-2xl border-border/70 shadow-sm">
      <div className="border-b border-border/70 p-4">
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <Package className="h-4 w-4 text-orange-500" aria-hidden="true" />
          Products
        </h3>
        <p className="text-xs text-muted-foreground mb-3">Type or scan a barcode — ↑↓ to navigate, Enter to add</p>
        <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
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
            className="rounded-xl border-border/70 bg-background/60 pl-9 focus-visible:ring-orange-500/50"
            autoFocus
            data-testid="input-product-search"
          />
        </div>
        <MobileBarcodeScanner onScan={(code) => model.scanProductFromCamera(code)} disabled={!model.locationId} />
        </div>
      </div>
      <div className="min-h-[190px] max-h-[calc(100vh-24rem)] flex-1 overflow-y-auto p-3">
        {!model.locationId ? (
          <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-orange-500/10 bg-orange-500/5 text-muted-foreground">
            <Package className="h-9 w-9 text-orange-500/70" />
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
    </div>
  );
}
