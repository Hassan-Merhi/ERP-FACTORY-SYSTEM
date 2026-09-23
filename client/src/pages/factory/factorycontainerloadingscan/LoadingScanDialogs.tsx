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
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-yellow-500" />
            {model.tr("proformaAlreadyLoading")}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">
            {pendingOrders.length === 1
              ? model.tr("pendingLoadingDescriptionOne")
              : model.tr("pendingLoadingDescriptionMany", { count: pendingOrders.length })}
          </p>
          <div className="space-y-2">
            {pendingOrders.map((order) => (
              <div key={order.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                <div className="text-sm">
                  <span className="font-medium">{order.invoiceNumber || model.tr("orderNumber", { orderId: order.id })}</span>
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
                  {model.tr("resume")}
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
            {model.tr("startNewLoading")}
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
      <DialogContent className="max-w-sm rounded-2xl" data-testid="dialog-last-scanned">
        <DialogHeader>
          <DialogTitle className="text-base">{model.tr("resumingLoading")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-sm text-muted-foreground">{model.tr("lastBaleScanned")}</p>
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
            {model.tr("continueScanning")}
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
      <AlertDialogContent className="rounded-2xl" data-testid="dialog-confirm-empty-container">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/10">
              <AlertTriangle className="h-4 w-4 text-destructive" />
            </span>
            {model.tr("emptyThisContainer")}
          </AlertDialogTitle>
          <AlertDialogDescription className="rounded-xl border bg-muted/20 p-3">
            {model.tr("emptyContainerDescription", { count: baleCount, orderId: model.orderId ?? "" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-testid="button-cancel-empty-container">{model.tr("cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground"
            data-testid="button-confirm-empty-container"
            disabled={model.emptyContainerMutation.isPending}
            onClick={() => model.emptyContainerMutation.mutate()}
          >
            {model.emptyContainerMutation.isPending ? model.tr("emptying") : model.tr("emptyContainer")}
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
      <AlertDialogContent className="rounded-2xl" data-testid="dialog-confirm-remove-bale">
        <AlertDialogHeader>
          <AlertDialogTitle>{model.tr("removeBaleQuestion")}</AlertDialogTitle>
          <AlertDialogDescription>
            {model.tr("removeBaleDescription", { reference: baleToDelete?.baleReference ?? "" })}
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
            {model.tr("removeBale")}
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
