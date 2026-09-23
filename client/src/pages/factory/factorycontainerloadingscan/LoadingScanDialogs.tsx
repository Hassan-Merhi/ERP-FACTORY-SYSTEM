/**
 * The remaining container loading scan dialogs: the pending-loading warning
 * that offers to resume an open order for the same proforma, the resume
 * "last scanned" prompt, and the bale removal confirmation.
 *
 * Split out of FactoryContainerLoadingScan.tsx unchanged.
 */
import { AlertTriangle, ArrowRight } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { FactoryContainerLoadingScanModel } from "./useFactoryContainerLoadingScanModel";

function PendingLoadingWarning({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { pendingOrders } = model;
  return (
    <Dialog open={model.showPendingWarning} onOpenChange={model.setShowPendingWarning}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            Proforma Already Being Loaded
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            This proforma already has{" "}
            {pendingOrders.length === 1 ? "an active loading order" : `${pendingOrders.length} active loading orders`}.
            You can continue one of them or start a new loading.
          </p>
          <div className="space-y-2">
            {pendingOrders.map((order) => (
              <div key={order.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="text-sm">
                  <span className="font-medium">{order.invoiceNumber || `Order #${order.id}`}</span>
                  <span className="text-muted-foreground ml-2">
                    · {order.totalQtyBales} bales · {order.status}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    model.setShowPendingWarning(false);
                    model.navigate(`/factory/sales/loading/new?orderId=${order.id}`);
                  }}
                  data-testid={`button-resume-order-${order.id}`}
                >
                  Resume
                  <ArrowRight className="h-3 w-3 ml-1" />
                </Button>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter className="flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => model.setShowPendingWarning(false)}
            data-testid="button-cancel-pending-warning"
          >
            Cancel
          </Button>
          <Button onClick={model.startNewLoadingAnyway} data-testid="button-create-new-loading">
            Start New Loading
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LastScannedPrompt({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { lastScannedRef } = model;
  return (
    <Dialog open={model.showLastScannedPopup} onOpenChange={model.setShowLastScannedPopup}>
      <DialogContent className="max-w-sm" data-testid="dialog-last-scanned">
        <DialogHeader>
          <DialogTitle className="text-base">Resuming Loading</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">Last bale scanned in this session:</p>
          <div
            className="bg-muted rounded-md px-4 py-3 font-mono text-lg font-semibold text-center"
            data-testid="text-last-scanned-ref"
          >
            {lastScannedRef?.baleReference}
            {lastScannedRef?.baleName && (
              <div className="text-sm font-normal text-muted-foreground mt-1">{lastScannedRef.baleName}</div>
            )}
          </div>
          <Button
            className="w-full"
            onClick={() => model.setShowLastScannedPopup(false)}
            data-testid="button-dismiss-last-scanned"
          >
            Continue Scanning
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function EmptyContainerConfirm({ model }: { model: FactoryContainerLoadingScanModel }) {
  const baleCount = model.bales.length;
  return (
    <AlertDialog open={model.showEmptyContainerConfirm} onOpenChange={model.setShowEmptyContainerConfirm}>
      <AlertDialogContent data-testid="dialog-confirm-empty-container">
        <AlertDialogHeader>
          <AlertDialogTitle>Empty this container?</AlertDialogTitle>
          <AlertDialogDescription>
            All {baleCount} scanned bale{baleCount === 1 ? "" : "s"} will be removed from Loading #{model.orderId} and
            returned to stock. The customer, proforma, loading location, and note will stay in place so you can start
            scanning again from zero.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-empty-container">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground"
            data-testid="button-confirm-empty-container"
            disabled={model.emptyContainerMutation.isPending}
            onClick={() => model.emptyContainerMutation.mutate()}
          >
            {model.emptyContainerMutation.isPending ? "Emptying…" : "Empty Container"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RemoveBaleConfirm({ model }: { model: FactoryContainerLoadingScanModel }) {
  const { baleToDelete } = model;
  return (
    <AlertDialog
      open={!!baleToDelete}
      onOpenChange={(open) => {
        if (!open) model.setBaleToDelete(null);
      }}
    >
      <AlertDialogContent data-testid="dialog-confirm-remove-bale">
        <AlertDialogHeader>
          <AlertDialogTitle>Remove bale from loading?</AlertDialogTitle>
          <AlertDialogDescription>
            Bale <span className="font-mono font-semibold">{baleToDelete?.baleReference}</span> will be removed from
            this loading and returned to stock. This cannot be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-remove-bale">Cancel</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground"
            data-testid="button-confirm-remove-bale"
            onClick={() => {
              if (baleToDelete) {
                model.removeBaleMutation.mutate(baleToDelete.id);
                model.setBaleToDelete(null);
              }
            }}
          >
            Remove Bale
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function LoadingScanDialogs({ model }: { model: FactoryContainerLoadingScanModel }) {
  return (
    <>
      {/* Pending Loading Warning Dialog */}
      <PendingLoadingWarning model={model} />
      <LastScannedPrompt model={model} />
      <EmptyContainerConfirm model={model} />
      {/* Bale removal confirmation */}
      <RemoveBaleConfirm model={model} />
    </>
  );
}
