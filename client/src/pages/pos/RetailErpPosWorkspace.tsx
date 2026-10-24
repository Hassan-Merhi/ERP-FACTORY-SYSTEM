import type { RefObject } from "react";
import { Minus, Percent, Plus, ScanLine, ShoppingCart, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RetailPhotoGallery } from "@/pages/retail/RetailProductImage";
import { RetailCameraScanner } from "./RetailCameraScanner";
import { RetailScanFeedback } from "./RetailScanFeedback";
import { money, type CartLine, type RetailPosItem, type ScanOutcome } from "./retailPosTypes";
import type { RetailPricedLinePreview } from "./retailWave2Types";

interface RetailErpPosSaleGridProps {
  cart: CartLine[];
  pricingLines: RetailPricedLinePreview[];
  units: number;
  total: number;
  onDecrease: (variantId: number) => void;
  onIncrease: (line: CartLine) => void;
  onAdjust: (line: CartLine) => void;
  onRemove: (variantId: number) => void;
}

/** ERP-style sales grid, but with exact retail variant IDs and a photo viewer. */
export function RetailErpPosSaleGrid({
  cart,
  pricingLines,
  units,
  total,
  onDecrease,
  onIncrease,
  onAdjust,
  onRemove,
}: RetailErpPosSaleGridProps) {
  return (
    <Card className="overflow-hidden min-w-0" id="retail-pos-cart">
      <div className="overflow-x-auto">
        <div className="min-w-[570px]">
          <div className="grid grid-cols-[35px_minmax(220px,1fr)_98px_85px_100px_82px] border-b bg-foreground/6 text-[11px] font-semibold text-muted-foreground dark:bg-muted/40">
            <div className="border-r px-2 py-3 text-center">#</div>
            <div className="border-r px-3 py-3">Item</div>
            <div className="border-r px-2 py-3 text-center">Qty</div>
            <div className="border-r px-2 py-3 text-right">Rate</div>
            <div className="border-r px-2 py-3 text-right">Amt</div>
            <div className="px-2 py-3 text-center">Actions</div>
          </div>
          {cart.map((line, rowIndex) => {
            const priced = pricingLines.find((entry) => entry.variantId === line.variantId);
            const adjusted = line.priceOverride != null || (line.discountType ?? "none") !== "none";
            const rate = priced?.unitPrice ?? line.priceOverride ?? line.promotion?.promotionPrice ?? line.price;
            const amount = priced?.lineTotal ?? rate * line.cartQuantity;
            return (
              <div
                key={line.variantId}
                className="grid grid-cols-[35px_minmax(220px,1fr)_98px_85px_100px_82px] items-center border-b text-sm hover:bg-muted/25"
                data-testid="cart-line"
              >
                <div className="text-center text-xs text-muted-foreground">{rowIndex + 1}</div>
                <div className="flex min-w-0 items-center gap-2 border-x p-2">
                  <RetailPhotoGallery
                    images={line.imageUrls ?? []}
                    title={`${line.brand} · ${line.name} · ${line.color} / ${line.size}`}
                    imageClassName="h-12 w-12 rounded-md border"
                  />
                  <div className="min-w-0 flex-1" data-no-translate>
                    <div className="truncate font-semibold">{line.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {line.brand} · {line.color} / {line.size}
                    </div>
                    <div className="truncate font-mono text-[10px] text-muted-foreground">{line.barcode}</div>
                    {adjusted && (
                      <div className="text-[11px] font-medium text-emerald-700 dark:text-emerald-400">
                        Discount / override applied
                      </div>
                    )}
                    {line.cartQuantity > line.quantity && (
                      <div className="text-xs text-destructive">Above available stock ({line.quantity})</div>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-center gap-1">
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => onDecrease(line.variantId)}
                    aria-label={`Decrease ${line.name} quantity`}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </Button>
                  <span
                    className="min-w-5 text-center font-mono"
                    data-testid={`retail-grid-quantity-${line.variantId}`}
                  >
                    {line.cartQuantity}
                  </span>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => onIncrease(line)}
                    aria-label={`Increase ${line.name} quantity`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <div className="border-x px-2 text-right font-mono text-xs" data-no-translate>
                  {money(rate)}
                </div>
                <div className="border-r bg-muted/20 px-2 text-right font-mono font-semibold" data-no-translate>
                  {money(amount)}
                </div>
                <div className="flex justify-center">
                  <Button
                    type="button"
                    size="icon"
                    variant={adjusted ? "secondary" : "ghost"}
                    className="h-8 w-8"
                    onClick={() => onAdjust(line)}
                    title="Discount or price override"
                    aria-label="Line discount or price override"
                    data-testid="retail-line-discount"
                  >
                    <Percent className="h-4 w-4" />
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8"
                    onClick={() => onRemove(line.variantId)}
                    title="Remove item"
                    aria-label={`Remove ${line.name} from sale`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            );
          })}
          {!cart.length && (
            <div className="flex h-14 items-center border-b px-3 text-sm text-muted-foreground">
              <span className="w-8 text-center">1</span>
              <span className="ml-2">Type to search or scan an item from the sidebar…</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-4 bg-muted/20 px-3 py-2 text-sm">
            <div className="text-muted-foreground">
              <strong className="text-foreground">{cart.length}</strong> items · Qty{" "}
              <strong className="font-mono text-foreground">{units.toFixed(2)}</strong>
            </div>
            <div className="flex items-baseline gap-2">
              <span className="text-muted-foreground">Total</span>
              <strong className="font-mono text-2xl">{money(total)}</strong>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}

interface RetailErpPosItemPickerProps {
  items: RetailPosItem[];
  searchText: string;
  onSearchChange: (search: string) => void;
  onBarcodeSubmit: (barcode: string) => void;
  onPick: (item: RetailPosItem) => void;
  scanInputRef: RefObject<HTMLInputElement | null>;
  loading: boolean;
  hasLocation: boolean;
  lastScan: ScanOutcome | null;
}

/** Same side-panel search pattern as ERP POS; photo clicks never select or sell. */
export function RetailErpPosItemPicker({
  items,
  searchText,
  onSearchChange,
  onBarcodeSubmit,
  onPick,
  scanInputRef,
  loading,
  hasLocation,
  lastScan,
}: RetailErpPosItemPickerProps) {
  return (
    <Card
      className="flex min-h-[340px] flex-col overflow-hidden xl:sticky xl:top-3 xl:max-h-[min(76vh,760px)]"
      aria-label="Retail POS item selection"
    >
      <div className="border-b p-3">
        <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
          <ScanLine className="h-4 w-4" /> Items
          <span className="ml-auto text-xs font-normal text-muted-foreground">Exact color / size</span>
        </div>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            onBarcodeSubmit(searchText);
          }}
        >
          <div className="relative min-w-0 flex-1">
            <ScanLine className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={scanInputRef}
              autoFocus
              autoComplete="off"
              inputMode="search"
              enterKeyHint="go"
              value={searchText}
              onChange={(event) => onSearchChange(event.target.value)}
              placeholder="Scan barcode or search..."
              className="pl-9"
              aria-label="Scan barcode or search retail items"
              data-testid="retail-pos-scan"
            />
          </div>
          <RetailCameraScanner onScan={onBarcodeSubmit} />
        </form>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain" aria-live="polite">
        {!hasLocation ? (
          <div className="p-5 text-sm text-muted-foreground">Select a selling location to load retail items.</div>
        ) : loading ? (
          <div className="p-5 text-sm text-muted-foreground">Loading variants…</div>
        ) : (
          <>
            {items.map((item) => (
              <div
                key={item.variantId}
                className="flex min-h-[68px] items-center gap-2 border-b px-3 py-2 hover:bg-muted/30"
              >
                <RetailPhotoGallery
                  images={item.imageUrls ?? []}
                  title={`${item.brand} · ${item.name} · ${item.color} / ${item.size}`}
                  imageClassName="h-12 w-12 rounded-md border"
                />
                <button
                  type="button"
                  onClick={() => onPick(item)}
                  className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Add ${item.name}, ${item.color}, size ${item.size} to sale`}
                >
                  <div className="truncate text-sm font-semibold" data-no-translate>
                    {item.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground" data-no-translate>
                    {item.brand} · {item.color} / {item.size}
                  </div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground" data-no-translate>
                    {item.barcode}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2 text-xs">
                    <span className="font-semibold" data-no-translate>
                      {item.promotion ? money(item.promotion.promotionPrice) : money(item.price)}
                    </span>
                    <span
                      className={item.quantity <= 0 ? "text-destructive" : "text-emerald-600 dark:text-emerald-400"}
                    >
                      {item.quantity <= 0 ? "Out" : `Stock ${item.quantity}`}
                    </span>
                  </div>
                </button>
              </div>
            ))}
            {!items.length && <div className="p-5 text-sm text-muted-foreground">No matching retail variants.</div>}
          </>
        )}
      </div>
      {lastScan && (
        <div className="max-h-52 overflow-y-auto border-t p-2">
          <RetailScanFeedback outcome={lastScan} />
        </div>
      )}
      <div className="flex items-center justify-between border-t px-3 py-2 text-xs text-muted-foreground">
        <span>Scan or select a variant to add it</span>
        <ShoppingCart className="h-4 w-4" />
      </div>
    </Card>
  );
}
