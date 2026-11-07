import { Undo2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { useBalesHistoryModel } from "../useBalesHistoryModel";

type Model = ReturnType<typeof useBalesHistoryModel>;

export function BalesHistoryDialog5({ model }: { model: Model }) {
  const {
    wrapAdminAction,
    returnToStockBale,
    setReturnToStockBale,
    returnToStockOrderInfo,
    orderInfoLoading,
    returnToStockMutation,
    recordChangeReason,
  } = model;
  return (
    <Dialog
      open={!!returnToStockBale}
      onOpenChange={(open) => {
        if (!open) setReturnToStockBale(null);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Undo2 className="h-5 w-5 text-blue-500" />
            Return Bale to Stock
          </DialogTitle>
          <DialogDescription>
            Bale <span className="font-mono font-semibold">{returnToStockBale?.bale?.referenceNumber}</span>
            {returnToStockBale?.product?.name || returnToStockBale?.bale?.productName
              ? ` — ${returnToStockBale?.product?.name || returnToStockBale?.bale?.productName}`
              : ""}{" "}
            ({returnToStockBale?.bale?.weightKg} kg)
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          {orderInfoLoading ? (
            <div className="text-sm text-muted-foreground py-2">Loading order details...</div>
          ) : returnToStockOrderInfo ? (
            <>
              <div className="rounded-md border p-3 space-y-1.5 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Order status</span>
                  <Badge variant="secondary" className="text-xs">
                    {returnToStockOrderInfo.status}
                  </Badge>
                </div>
                {returnToStockOrderInfo.invoiceNumber && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Invoice</span>
                    <span className="font-mono font-semibold">{returnToStockOrderInfo.invoiceNumber}</span>
                  </div>
                )}
                {returnToStockOrderInfo.customerName && (
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Customer</span>
                    <span>{returnToStockOrderInfo.customerName}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Current total</span>
                  <span className="font-mono">
                    $
                    {parseFloat(returnToStockOrderInfo.grandTotal || "0").toLocaleString(undefined, {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Bales in order</span>
                  <span>{returnToStockOrderInfo.totalBalesInOrder}</span>
                </div>
              </div>

              {returnToStockOrderInfo.totalBalesInOrder <= 1 && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>This is the last bale in the order. You must cancel the entire order instead.</p>
                </div>
              )}

              {returnToStockOrderInfo.status === "FINALIZED" && returnToStockOrderInfo.totalBalesInOrder > 1 && (
                <div className="flex items-start gap-2 p-3 rounded-md bg-amber-50 dark:bg-amber-950/20 text-amber-800 dark:text-amber-300 text-sm">
                  <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0" />
                  <p>
                    This order is <strong>finalized</strong>. Removing this bale will reduce invoice{" "}
                    <strong>{returnToStockOrderInfo.invoiceNumber}</strong> and update the customer's balance. The
                    invoice number will not change. Admin authorisation required.
                  </p>
                </div>
              )}

              {!["FINALIZED"].includes(returnToStockOrderInfo.status) &&
                returnToStockOrderInfo.totalBalesInOrder > 1 && (
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

        {recordChangeReason && (
          <p className="text-sm text-muted-foreground" data-testid="text-return-to-stock-denied">
            {recordChangeReason}
          </p>
        )}
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => setReturnToStockBale(null)}
            data-testid="button-cancel-return-to-stock"
          >
            Cancel
          </Button>
          <Button
            disabled={
              !!recordChangeReason ||
              returnToStockMutation.isPending ||
              orderInfoLoading ||
              returnToStockOrderInfo?.totalBalesInOrder <= 1
            }
            title={recordChangeReason ?? undefined}
            onClick={() => {
              if (!returnToStockBale) return;
              const isFinalized = returnToStockOrderInfo?.status === "FINALIZED";
              const doIt = () => returnToStockMutation.mutate(returnToStockBale.bale.id);
              if (isFinalized) {
                wrapAdminAction(doIt, "Return Bale to Stock (Finalized Order)");
              } else {
                doIt();
              }
            }}
            data-testid="button-confirm-return-to-stock"
          >
            {returnToStockMutation.isPending ? "Processing..." : "Return to Stock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
