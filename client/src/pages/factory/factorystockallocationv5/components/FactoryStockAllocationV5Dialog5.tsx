import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@/components/ui/dialog";
import type { useFactoryStockAllocationV5Model } from "../useFactoryStockAllocationV5Model";

type Model = ReturnType<typeof useFactoryStockAllocationV5Model>;
export function FactoryStockAllocationV5Dialog5({ model }: { model: Model }) {
  const { restoreDialogOpen, setRestoreDialogOpen, cancelledContainersQuery, restoreContainerMut } = model;
  return (
    <Dialog
      open={restoreDialogOpen}
      onOpenChange={(open) => {
        if (!open) setRestoreDialogOpen(false);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="h-4 w-4 text-muted-foreground" />
            Restore Cancelled Container
          </DialogTitle>
          <DialogDescription>
            Cancelled V5 containers from the last 30 days. Restoring puts the container back to its previous status. Any
            bales that were scanned in will need to be re-scanned.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 max-h-[400px] overflow-y-auto py-1">
          {cancelledContainersQuery.isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : cancelledContainersQuery.isError ? (
            <p className="text-sm text-destructive text-center py-4">Failed to load cancelled containers.</p>
          ) : (cancelledContainersQuery.data?.orders ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No recently cancelled containers found (last 30 days).
            </p>
          ) : (
            (cancelledContainersQuery.data?.orders ?? []).map((order) => (
              <div
                key={order.id}
                className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
                data-testid={`row-cancelled-container-${order.id}`}
              >
                <div className="flex flex-col gap-0.5 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{order.containerNumber}</span>
                    <Badge variant="outline" className="text-[11px] h-4 px-1">
                      {order.wasLoading ? "Was Loading" : "Was Draft"}
                    </Badge>
                  </div>
                  <span className="text-xs text-muted-foreground truncate">
                    {order.customerName}
                    {order.proformaName ? ` · ${order.proformaName}` : ""}
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    Cancelled {new Date(order.cancelledAt).toLocaleDateString()}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => restoreContainerMut.mutate(order.id)}
                  disabled={restoreContainerMut.isPending}
                  data-testid={`button-restore-container-${order.id}`}
                >
                  {restoreContainerMut.isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <>
                      <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
                      Restore
                    </>
                  )}
                </Button>
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setRestoreDialogOpen(false)}
            data-testid="button-restore-dialog-close"
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
