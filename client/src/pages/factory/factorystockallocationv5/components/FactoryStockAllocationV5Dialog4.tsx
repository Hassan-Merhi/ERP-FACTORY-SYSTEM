import { Loader2, AlertTriangle, CheckCircle2, Link2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { STATUS_LABELS } from "../utils";
import type { useFactoryStockAllocationV5Model } from "../useFactoryStockAllocationV5Model";

type Model = ReturnType<typeof useFactoryStockAllocationV5Model>;
export function FactoryStockAllocationV5Dialog4({ model }: { model: Model }) {
  const { linkDialog, setLinkDialog, linkSelected, setLinkSelected, unlinkedQuery, linkMut } = model;
  return (
    <Dialog
      open={!!linkDialog}
      onOpenChange={(open) => {
        if (!open) {
          setLinkDialog(null);
          setLinkSelected(new Set());
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-muted-foreground" />
            Link Existing Container
          </DialogTitle>
        </DialogHeader>

        {linkDialog && (
          <div className="flex flex-col gap-4 py-1">
            <p className="text-sm text-muted-foreground">
              Linking to <span className="font-semibold text-foreground">{linkDialog.proformaName}</span>.
            </p>

            <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/20 rounded-md px-3 py-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Only link containers that truly belong to this proforma. Expected quantities will be set from this
                proforma's lines and container progress will appear in Stock Allocation V5.
              </p>
            </div>

            {unlinkedQuery.isLoading ? (
              <div className="flex items-center justify-center py-6">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : unlinkedQuery.isError ? (
              <p className="text-sm text-destructive">Failed to load unlinked containers.</p>
            ) : (unlinkedQuery.data?.orders ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4 italic">
                No unlinked LOADING containers found.
              </p>
            ) : (
              <div className="rounded-md border overflow-hidden max-h-72 overflow-y-auto">
                <div className="grid grid-cols-[20px_1fr_80px_64px_56px] bg-muted px-3 py-2 gap-2 text-xs font-medium text-muted-foreground border-b sticky top-0">
                  <span />
                  <span>Container / Customer</span>
                  <span className="text-right">Loaded</span>
                  <span className="text-right">Date</span>
                  <span />
                </div>
                {(unlinkedQuery.data?.orders ?? []).map((order) => {
                  const isSelected = linkSelected.has(order.id);
                  const customerMismatch =
                    linkDialog.proformaCustomerId != null &&
                    order.customerId != null &&
                    order.customerId !== linkDialog.proformaCustomerId;
                  return (
                    <div
                      key={order.id}
                      className={cn(
                        "grid grid-cols-[20px_1fr_80px_64px_56px] px-3 py-2 gap-2 items-center text-xs border-b last:border-0",
                        customerMismatch ? "opacity-50 cursor-not-allowed" : "cursor-pointer hover-elevate",
                        isSelected && "bg-primary/5"
                      )}
                      onClick={() => {
                        if (customerMismatch) return;
                        setLinkSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(order.id)) next.delete(order.id);
                          else next.add(order.id);
                          return next;
                        });
                      }}
                      data-testid={`row-unlinked-order-${order.id}`}
                    >
                      <div
                        className={cn(
                          "w-4 h-4 rounded-sm border flex items-center justify-center shrink-0",
                          isSelected ? "bg-primary border-primary" : "border-muted-foreground/30",
                          customerMismatch && "border-muted-foreground/15"
                        )}
                      >
                        {isSelected && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
                      </div>
                      <div className="min-w-0">
                        <div className="font-medium truncate">{order.containerNumber}</div>
                        <div className="text-muted-foreground truncate">{order.customerName}</div>
                        {customerMismatch && (
                          <div className="text-destructive text-[10px]">Customer mismatch — cannot link</div>
                        )}
                      </div>
                      <div className="text-right font-mono tabular-nums">
                        <span className="text-blue-600 dark:text-blue-400">{order.loadedBaleCount}</span>
                        <span className="text-muted-foreground ml-0.5">bales</span>
                      </div>
                      <div className="text-right text-muted-foreground tabular-nums">
                        {new Date(order.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                      </div>
                      <div>
                        <Badge variant="outline" className="text-[9px] h-4 px-1">
                          {STATUS_LABELS[order.status] ?? order.status}
                        </Badge>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() => {
              setLinkDialog(null);
              setLinkSelected(new Set());
            }}
            data-testid="button-v5-link-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={() =>
              linkDialog && linkMut.mutate({ proformaId: linkDialog.proformaId, orderIds: Array.from(linkSelected) })
            }
            disabled={linkMut.isPending || linkSelected.size === 0}
            data-testid="button-v5-link-submit"
          >
            {linkMut.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Linking…
              </>
            ) : (
              `Link ${linkSelected.size > 0 ? linkSelected.size + " " : ""}Container${linkSelected.size !== 1 ? "s" : ""}`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
