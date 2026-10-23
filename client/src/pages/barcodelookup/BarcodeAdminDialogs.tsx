import { AlertTriangle, ArrowLeftRight, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useBarcodeLookupModel } from "./useBarcodeLookupModel";

type BarcodeLookupModel = ReturnType<typeof useBarcodeLookupModel>;

export function BarcodeAdminDialogs({ model }: { model: BarcodeLookupModel }) {
  const referenceNumber = model.referenceResult?.labelPrint?.referenceNumber;
  const releasingOpenLoading = ["DRAFT", "LOADING"].includes(model.returnToStockOrderInfo?.status ?? "");

  return (
    <>
      <Dialog
        open={model.showRestoreDeletedDialog}
        onOpenChange={(open) => {
          if (model.restoreDeletedMutation.isPending) return;
          model.setShowRestoreDeletedDialog(open);
          if (!open) model.setRestoreReason("");
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-restore-deleted-bale">
          <DialogHeader>
            <DialogTitle>Restore Deleted Bale to Stock</DialogTitle>
            <DialogDescription>
              <span className="block">
                Restore <span className="font-mono font-semibold">{referenceNumber}</span> to its original location.
              </span>
              <span className="mt-2 block">
                The original stock debit will be reversed exactly once. The deletion record remains in the audit
                history.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="bale-restore-reason" className="text-sm font-medium">
              Reason for restoration
            </label>
            <Textarea
              id="bale-restore-reason"
              value={model.restoreReason}
              onChange={(event) => model.setRestoreReason(event.target.value)}
              placeholder="Why is this bale being returned to inventory?"
              maxLength={500}
              data-testid="input-restore-bale-reason"
            />
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => model.setShowRestoreDeletedDialog(false)}
              disabled={model.restoreDeletedMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={
                model.restoreDeletedMutation.isPending ||
                !model.restoreReason.trim() ||
                !model.referenceResult?.baleInfo?.id
              }
              onClick={() => {
                const baleId = model.referenceResult?.baleInfo?.id;
                if (baleId && model.restoreReason.trim()) {
                  model.restoreDeletedMutation.mutate({ baleId, reason: model.restoreReason.trim() });
                }
              }}
              data-testid="button-confirm-restore-deleted-bale"
            >
              {model.restoreDeletedMutation.isPending ? "Restoring..." : "Confirm Restore to Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={model.showDeleteDialog} onOpenChange={model.setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Bale Everywhere</DialogTitle>
            <DialogDescription>
              This will permanently soft-delete the factory bale record for{" "}
              <span className="font-mono font-semibold">{referenceNumber}</span>. The label print history will remain
              for audit purposes. This action cannot be undone from here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => model.setShowDeleteDialog(false)}
              disabled={model.deleteBaleMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={model.deleteBaleMutation.isPending}
              onClick={() => referenceNumber && model.deleteBaleMutation.mutate(referenceNumber)}
              data-testid="button-confirm-delete-bale"
            >
              {model.deleteBaleMutation.isPending ? "Deleting..." : "Yes, Delete Bale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={model.showChangeProductDialog}
        onOpenChange={(open) => {
          model.setShowChangeProductDialog(open);
          if (!open) {
            model.setSelectedNewProductId(null);
            model.setChangeProductSearch("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Change Linked Bale Product</DialogTitle>
            <DialogDescription>
              Select a new product to link to reference{" "}
              <span className="font-mono font-semibold">{referenceNumber}</span>. This will update the article code,
              bale code and product name on the bale record and label print.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <Input
              placeholder="Search by name or article code..."
              value={model.changeProductSearch}
              onChange={(event) => model.setChangeProductSearch(event.target.value)}
              data-testid="input-change-product-search"
            />
            <div className="border rounded-md max-h-64 overflow-y-auto">
              {model.filteredBaleProducts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">No products found</p>
              ) : (
                model.filteredBaleProducts.map((product) => (
                  <button
                    key={product.id}
                    type="button"
                    className={`w-full text-left px-3 py-2 text-sm hover-elevate ${model.selectedNewProductId === product.id ? "bg-muted font-semibold" : ""}`}
                    onClick={() => model.setSelectedNewProductId(product.id)}
                    data-testid={`item-product-${product.id}`}
                  >
                    <span className="font-medium">{product.name}</span>
                    {product.articleCode && (
                      <span className="ml-2 text-muted-foreground font-mono text-xs">{product.articleCode}</span>
                    )}
                    <span className="ml-2 text-muted-foreground font-mono text-xs">{product.code}</span>
                  </button>
                ))
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 flex-wrap">
            <Button
              variant="outline"
              onClick={() => model.setShowChangeProductDialog(false)}
              disabled={model.changeProductMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={!model.selectedNewProductId || model.changeProductMutation.isPending}
              onClick={() => {
                if (referenceNumber && model.selectedNewProductId) {
                  model.changeProductMutation.mutate({
                    refNum: referenceNumber,
                    newProductId: model.selectedNewProductId,
                  });
                }
              }}
              data-testid="button-confirm-change-product"
            >
              {model.changeProductMutation.isPending ? "Saving..." : "Confirm Change"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={model.showSwapDialog}
        onOpenChange={(open) => {
          if (!open) {
            model.setShowSwapDialog(false);
            model.setSwapRef("");
            model.setSwapPreview(null);
          }
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-swap-bale">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowLeftRight className="h-5 w-5 text-amber-500" />
              Swap Bale
            </DialogTitle>
            <DialogDescription>
              Replace <span className="font-mono font-semibold">{referenceNumber}</span> with another in-stock bale. The
              current bale returns to stock; the replacement takes its place in the order.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-1">
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Replacement Bale Reference</p>
              <div className="flex gap-2">
                <Input
                  placeholder="e.g. REF200012"
                  value={model.swapRef}
                  onChange={(event) => {
                    model.setSwapRef(event.target.value);
                    model.setSwapPreview(null);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && model.swapRef.trim()) model.swapPreviewMutation.mutate(model.swapRef);
                  }}
                  data-testid="input-swap-ref"
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!model.swapRef.trim() || model.swapPreviewMutation.isPending}
                  onClick={() => model.swapPreviewMutation.mutate(model.swapRef)}
                  data-testid="button-lookup-swap-ref"
                >
                  {model.swapPreviewMutation.isPending ? "Looking…" : "Look Up"}
                </Button>
              </div>
            </div>

            {model.swapPreview && (
              <div className="rounded-md border p-3 space-y-2 text-sm">
                <p className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Replacement Bale</p>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Reference</p>
                    <p className="font-mono font-semibold">{model.swapPreview.referenceNumber}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Status</p>
                    <p>
                      {model.swapPreview.status === "IN_STOCK" ? (
                        <span className="text-green-600 dark:text-green-400 font-medium">In Stock</span>
                      ) : (
                        <span className="text-destructive font-medium">{model.swapPreview.status}</span>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Product</p>
                    <p>{model.swapPreview.productName ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Weight</p>
                    <p>{model.swapPreview.weightKg} KG</p>
                  </div>
                  {model.swapPreview.articleCode && (
                    <div>
                      <p className="text-xs text-muted-foreground">Article Code</p>
                      <p className="font-mono">{model.swapPreview.articleCode}</p>
                    </div>
                  )}
                </div>
                {model.swapPreview.status !== "IN_STOCK" && (
                  <div className="flex items-start gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-xs">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <p>This bale is not IN_STOCK. Only in-stock bales can be used as replacements.</p>
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              The price used in the order remains unchanged. Order totals will be recalculated based on the replacement
              bale's weight.
            </p>
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => {
                model.setShowSwapDialog(false);
                model.setSwapRef("");
                model.setSwapPreview(null);
              }}
              data-testid="button-cancel-swap"
            >
              Cancel
            </Button>
            <Button
              disabled={!model.swapPreview || model.swapPreview.status !== "IN_STOCK" || model.swapMutation.isPending}
              onClick={() => {
                if (!referenceNumber || !model.swapPreview) return;
                model.swapMutation.mutate({
                  currentBaleRef: referenceNumber,
                  replacementBaleRef: model.swapPreview.referenceNumber,
                });
              }}
              data-testid="button-confirm-swap"
            >
              {model.swapMutation.isPending ? "Swapping…" : "Confirm Swap"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={model.showReturnToStockDialog}
        onOpenChange={(open) => {
          if (!open) model.setShowReturnToStockDialog(false);
        }}
      >
        <DialogContent className="max-w-md" data-testid="dialog-return-to-stock">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Undo2 className="h-5 w-5 text-blue-500" />
              Return Bale to Stock
            </DialogTitle>
            <DialogDescription>
              Bale <span className="font-mono font-semibold">{referenceNumber}</span>
              {model.referenceResult?.baleInfo?.productName ? ` — ${model.referenceResult.baleInfo.productName}` : ""}
              {model.referenceResult?.baleInfo?.weightKg ? ` (${model.referenceResult.baleInfo.weightKg} kg)` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            {model.orderInfoLoading ? (
              <div className="text-sm text-muted-foreground py-2">Loading order details...</div>
            ) : model.returnToStockOrderInfo ? (
              <>
                <div className="rounded-md border p-3 space-y-1.5 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Order status</span>
                    <Badge variant="secondary" className="text-xs">
                      {model.returnToStockOrderInfo.status}
                    </Badge>
                  </div>
                  {model.returnToStockOrderInfo.invoiceNumber && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Invoice</span>
                      <span className="font-mono font-semibold">{model.returnToStockOrderInfo.invoiceNumber}</span>
                    </div>
                  )}
                  {model.returnToStockOrderInfo.customerName && (
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Customer</span>
                      <span>{model.returnToStockOrderInfo.customerName}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Current total</span>
                    <span className="font-mono">
                      $
                      {parseFloat(model.returnToStockOrderInfo.grandTotal || "0").toLocaleString(undefined, {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2,
                      })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Bales in order</span>
                    <span>{model.returnToStockOrderInfo.totalBalesInOrder}</span>
                  </div>
                </div>
                {model.returnToStockOrderInfo.totalBalesInOrder <= 1 && !releasingOpenLoading && (
                  <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                    <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                    <p>This is the last bale in the order. You must cancel the entire order instead.</p>
                  </div>
                )}
                {releasingOpenLoading && (
                  <p className="text-sm text-muted-foreground" data-testid="return-open-loading-info">
                    This bale will be removed from the current container loading and returned to available stock. The
                    loading's bale count, weight and totals will update. You can scan the same reference on another
                    loading immediately, even when this was the last bale in the current loading.
                  </p>
                )}
                {model.returnToStockOrderInfo.status === "FINALIZED" &&
                  model.returnToStockOrderInfo.totalBalesInOrder > 1 && (
                    <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-sm">
                      <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                      <p>
                        This order is <strong>finalized</strong>. Removing this bale will reduce invoice{" "}
                        <strong>{model.returnToStockOrderInfo.invoiceNumber}</strong> and update the customer's balance.
                        Admin authorisation required.
                      </p>
                    </div>
                  )}
                {model.returnToStockOrderInfo.status !== "FINALIZED" &&
                  !releasingOpenLoading &&
                  model.returnToStockOrderInfo.totalBalesInOrder > 1 && (
                    <p className="text-sm text-muted-foreground">
                      The bale will be removed from this order and returned to stock. Order totals will be recalculated.
                    </p>
                  )}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                No order linked to this bale — it will simply be returned to stock.
              </p>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => model.setShowReturnToStockDialog(false)}
              data-testid="button-cancel-return-to-stock"
            >
              Cancel
            </Button>
            <Button
              disabled={
                model.returnToStockMutation.isPending ||
                model.orderInfoLoading ||
                (!releasingOpenLoading && (model.returnToStockOrderInfo?.totalBalesInOrder ?? 0) <= 1)
              }
              onClick={() => {
                const baleId = model.referenceResult?.baleInfo?.id;
                if (!baleId) return;
                const run = () => model.returnToStockMutation.mutate(baleId);
                if (model.returnToStockOrderInfo?.status === "FINALIZED")
                  model.wrapAdminAction(run, "Return Bale to Stock (Finalized Order)");
                else run();
              }}
              data-testid="button-confirm-return-to-stock"
            >
              {model.returnToStockMutation.isPending ? "Processing..." : "Return to Stock"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
