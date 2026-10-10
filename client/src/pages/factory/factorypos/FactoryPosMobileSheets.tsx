/**
 * Mobile-only surfaces of the Factory POS page: the product browse sheet, the
 * row edit sheet, the add FAB and the sticky save bar.
 *
 * Split out of FactoryPOS.tsx unchanged, including the Enter-to-add barcode
 * shortcut in the browse sheet and the sticky bar's net-vs-gross label.
 */
import { Check, ChevronRight, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { formatNum } from "./utils";
import type { FactoryPosModel } from "./useFactoryPosModel";

function MobileBrowseSheet({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, mobileFilteredInventory } = model;
  return (
    <Sheet open={model.mobileBrowseOpen} onOpenChange={model.setMobileBrowseOpen}>
      <SheetContent side="bottom" className="h-[80vh] flex flex-col">
        <div className="pb-3 border-b">
          <div className="text-base font-semibold mb-3">Add Product</div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              placeholder="Scan barcode or search..."
              value={model.mobileBrowseSearch}
              onChange={(e) => model.setMobileBrowseSearch(e.target.value)}
              onKeyDown={model.handleMobileSearchKeyDown}
              className="pl-9"
              autoFocus
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto space-y-1 pt-3">
          {!model.locationId ? (
            <div className="text-center text-muted-foreground text-sm py-8">Select a location first</div>
          ) : mobileFilteredInventory.length === 0 ? (
            <div className="text-center text-muted-foreground text-sm py-8">No products in stock</div>
          ) : (
            mobileFilteredInventory.map((item) => {
              const price = parseFloat(item.sellingPrice || "0");
              return (
                <button
                  key={item.productId}
                  onClick={() => model.addProductFromMobile(item)}
                  className="w-full text-left rounded-md px-3 py-2.5 border hover-elevate active-elevate-2 flex items-center justify-between gap-2"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium truncate">{item.productName}</div>
                    <div className="text-xs text-muted-foreground">
                      Stock: {item.quantity}
                      {price > 0 ? ` · ${ccPrefix}${formatNum(price)}` : ""}
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                </button>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MobileRowEditSheet({ model }: { model: FactoryPosModel }) {
  const { mobileRow, mobileRowEditIdx, ccPrefix } = model;
  return (
    <Sheet open={model.mobileRowEditOpen} onOpenChange={model.setMobileRowEditOpen}>
      <SheetContent side="bottom" className="h-auto">
        {mobileRow && mobileRowEditIdx !== null && (
          <>
            <div className="pb-3 border-b">
              <div className="text-base font-semibold truncate">{mobileRow.productName}</div>
              {mobileRow.articleCode && <div className="text-xs text-muted-foreground">{mobileRow.articleCode}</div>}
            </div>
            <div className="space-y-4 pt-4">
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Quantity (max {mobileRow.availableQty || "∞"})</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={mobileRow.quantity}
                  onChange={(e) => model.updateRow(mobileRowEditIdx, "quantity", e.target.value)}
                  className="text-right font-mono h-12 text-lg"
                  style={{ fontSize: "18px" }}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-sm font-medium">Unit Price ({model.currencyCode})</Label>
                <Input
                  type="number"
                  inputMode="decimal"
                  value={mobileRow.unitPrice}
                  onChange={(e) => model.updateRow(mobileRowEditIdx, "unitPrice", e.target.value)}
                  className="text-right font-mono h-12 text-lg"
                  placeholder="0"
                  style={{ fontSize: "18px" }}
                />
              </div>
              <div className="rounded-md bg-muted/30 border px-3 py-2.5 flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Amount</span>
                <span className="text-lg font-semibold font-mono">
                  {ccPrefix}
                  {formatNum(mobileRow.quantity * mobileRow.unitPrice)}
                </span>
              </div>
              <div className="flex gap-2 pt-1 pb-2">
                <Button
                  variant="destructive"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    model.deleteRow(mobileRowEditIdx);
                    model.setMobileRowEditOpen(false);
                  }}
                >
                  <Trash2 className="h-4 w-4 mr-1.5" />
                  Remove
                </Button>
                <Button size="sm" className="flex-1" onClick={() => model.setMobileRowEditOpen(false)}>
                  <Check className="h-4 w-4 mr-1.5" />
                  Done
                </Button>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function FactoryPosMobileSheets({ model }: { model: FactoryPosModel }) {
  const { ccPrefix, validRows, totalQty, totalWeight, total, netTotal, totalExpenseAmount } = model;
  return (
    <>
      <MobileBrowseSheet model={model} />
      <MobileRowEditSheet model={model} />

      {/* ── MOBILE: FAB ── */}
      <button
        className="md:hidden fixed bottom-20 right-4 z-40 h-14 w-14 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center active:scale-95 transition-transform"
        onClick={model.openMobileBrowse}
        data-testid="button-mobile-fab-add"
        aria-label="Add product"
      >
        <Plus className="h-7 w-7" />
      </button>

      {/* ── MOBILE: Sticky save bar ── */}
      <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-background border-t px-3 py-2 flex items-center gap-2">
        <div className="flex-1 min-w-0">
          <div className="text-xs text-muted-foreground">
            {validRows.length} items · Qty {totalQty}
            {totalWeight > 0 ? ` · ${formatNum(totalWeight)} kg` : ""}
          </div>
          <div className="text-base font-semibold font-mono leading-tight" data-testid="text-sticky-total">
            {totalExpenseAmount > 0 ? `${ccPrefix}${formatNum(netTotal)} (net)` : `${ccPrefix}${formatNum(total)}`}
          </div>
        </div>
        <Button
          onClick={model.handleSubmit}
          disabled={model.saleMutation.isPending || validRows.length === 0}
          className="shrink-0 h-10 px-5"
          data-testid="button-mobile-sticky-save"
        >
          {model.saleMutation.isPending ? (
            "..."
          ) : (
            <>
              <Check className="h-4 w-4 mr-1.5" />
              Save
            </>
          )}
        </Button>
      </div>
    </>
  );
}
