// Extracted from ./StockEntryTab.tsx to keep that module under the source-size cap.
import { History, Package, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DraftRestorePrompt } from "@/components/DraftRestorePrompt";
import { StockEntryCart } from "./StockEntryCart";
import { StockEntryScanner } from "./StockEntryScanner";
import { StockEntryProductionPositions } from "./StockEntryProductionPositions";
import { capCartToItemLimit, type CartItem } from "./useStockEntryTabStatePart1";
import { useStockEntryTabState } from "./useStockEntryTabState";

export function StockEntryTabSection({
  allCustomers,
  assignProductionPosition,
  assignWorker,
  baleProducts,
  cart,
  cartDraft,
  cartDraftAge,
  discardCartDraft,
  filteredProducts,
  filteredWorkers,
  handleScan,
  handleScanKeyDown,
  hasCartDraft,
  logoPickerOpen,
  onOpenHistory,
  productionPositionByProduct,
  productionPositions,
  removeItem,
  scanError,
  scanInput,
  scanRef,
  selectProduct,
  setAdminAuthOpen,
  setCart,
  setEntryDate,
  setLogoOverride,
  setLogoPickerOpen,
  setPendingCreateName,
  setProductionPositionByProduct,
  setQty,
  setScanInput,
  setSelectedCustomerId,
  setSelectedLocationId,
  setSelectedLogoId,
  setShowDropdown,
  showDropdown,
  showHistory,
  updateQty,
  updateWeight,
  workerCategoryFilter,
  workers,
}: Pick<
  ReturnType<typeof useStockEntryTabState>,
  | "allCustomers"
  | "assignProductionPosition"
  | "assignWorker"
  | "baleProducts"
  | "cart"
  | "cartDraft"
  | "cartDraftAge"
  | "discardCartDraft"
  | "filteredProducts"
  | "filteredWorkers"
  | "handleScan"
  | "handleScanKeyDown"
  | "hasCartDraft"
  | "logoPickerOpen"
  | "onOpenHistory"
  | "productionPositionByProduct"
  | "productionPositions"
  | "removeItem"
  | "scanError"
  | "scanInput"
  | "scanRef"
  | "selectProduct"
  | "setAdminAuthOpen"
  | "setCart"
  | "setEntryDate"
  | "setLogoOverride"
  | "setLogoPickerOpen"
  | "setPendingCreateName"
  | "setProductionPositionByProduct"
  | "setQty"
  | "setScanInput"
  | "setSelectedCustomerId"
  | "setSelectedLocationId"
  | "setSelectedLogoId"
  | "setShowDropdown"
  | "showDropdown"
  | "showHistory"
  | "updateQty"
  | "updateWeight"
  | "workerCategoryFilter"
  | "workers"
>) {
  return (
    <div className="stock-entry-main min-w-0 space-y-4 xl:col-span-8">
      <Card className="border-none shadow-none bg-transparent">
        <CardHeader className="stock-entry-page-heading px-0 pb-4 pt-0">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <div className="stock-entry-heading-icon flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl text-sky-500">
                <Package className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <CardTitle className="text-lg font-extrabold tracking-tight sm:text-xl">New Production Entry</CardTitle>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm">Scan products to add production bales</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {showHistory && onOpenHistory && (
                <Button
                  variant="outline"
                  size="sm"
                  className="stock-entry-toolbar-button h-9 gap-1.5 rounded-xl px-3 text-xs font-semibold"
                  onClick={onOpenHistory}
                  data-testid="button-stock-entry-history"
                >
                  <History className="h-3.5 w-3.5" />
                  History
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                className="stock-entry-toolbar-button h-9 gap-1.5 rounded-xl border px-3 text-xs font-semibold"
                onClick={() => {
                  setAdminAuthOpen(true);
                  setPendingCreateName("");
                }}
                data-testid="button-quick-create"
              >
                <Plus className="h-3.5 w-3.5" />
                Quick Create Product
              </Button>
              {hasCartDraft && (
                <DraftRestorePrompt
                  draftAge={cartDraftAge ?? ""}
                  onRestore={() => {
                    const draftData = cartDraft?.data as
                      | {
                          cart?: CartItem[];
                          productionPositionByProduct?: Record<number, number | null>;
                          selectedLocationId?: string;
                          entryDate?: string;
                          selectedCustomerId?: string;
                          selectedLogoId?: number | null;
                        }
                      | undefined;
                    if (draftData?.cart) {
                      const restored = draftData.cart
                        .map((i) => {
                          const p = baleProducts?.find((bp) => bp.id === i.productId);
                          return {
                            ...i,
                            finalizedBy: i.finalizedBy ?? null,
                            overrideLogoId: i.overrideLogoId ?? null,
                            product: p,
                          };
                        })
                        .filter((i): i is CartItem => !!i.product);
                      setCart(capCartToItemLimit(restored));
                    }
                    if (draftData?.productionPositionByProduct) {
                      setProductionPositionByProduct(draftData.productionPositionByProduct);
                    }
                    if (draftData?.selectedLocationId) setSelectedLocationId(draftData.selectedLocationId);
                    if (draftData?.entryDate) setEntryDate(draftData.entryDate);
                    if (draftData?.selectedCustomerId) setSelectedCustomerId(draftData.selectedCustomerId);
                    if (draftData && "selectedLogoId" in draftData) setSelectedLogoId(draftData.selectedLogoId ?? null);
                    discardCartDraft();
                  }}
                  onDiscard={discardCartDraft}
                />
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent className="stock-entry-content space-y-4 px-0">
          <div className="stock-entry-scan-shell">
            <StockEntryScanner
              scanRef={scanRef}
              scanInput={scanInput}
              onScanInputChange={(val) => {
                setScanInput(val);
                setShowDropdown(true);
              }}
              onScanKeyDown={handleScanKeyDown}
              onCameraScan={handleScan}
              scanError={scanError}
              showDropdown={showDropdown}
              filteredProducts={filteredProducts}
              onSelectProduct={selectProduct}
            />
          </div>

          <div className="stock-entry-cart-shell">
            <StockEntryCart
              cart={cart}
              workers={workers}
              workerCategoryFilter={workerCategoryFilter}
              onUpdateQty={updateQty}
              onSetQty={setQty}
              onUpdateWeight={updateWeight}
              onRemoveItem={removeItem}
              onAssignWorker={assignWorker}
              onSetLogoOverride={setLogoOverride}
              allCustomers={allCustomers}
              logoPickerOpen={logoPickerOpen}
              onLogoPickerOpenChange={setLogoPickerOpen}
              filteredWorkers={filteredWorkers}
            />
          </div>

          <StockEntryProductionPositions
            cart={cart}
            workers={workers}
            positions={productionPositions}
            selectedByProduct={productionPositionByProduct}
            onSelect={assignProductionPosition}
          />
        </CardContent>
      </Card>
    </div>
  );
}
