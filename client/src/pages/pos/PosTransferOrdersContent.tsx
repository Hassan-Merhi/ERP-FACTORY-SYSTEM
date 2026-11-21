// Extracted from ./PosTransferOrders.tsx
import { CheckCircle2, ArrowRight, Clock, Eye, Pencil, Store, MapPin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatDate } from "./postransferorders/utils";
import { usePosTransferOrdersState } from "./usePosTransferOrdersState";

export function PosTransferOrdersContent({
  openView,
  setEditVoucherId,
  transfers,
}: Pick<ReturnType<typeof usePosTransferOrdersState>, "openView" | "setEditVoucherId" | "transfers">) {
  return (
    <div className="space-y-3">
      {transfers.map((transfer) => (
        <article
          key={transfer.voucherId}
          className={cn(
            "pos-orders-row group min-w-0 rounded-2xl border bg-card p-3 shadow-xs transition-all sm:p-4",
            transfer.inventoryApplied ? "pos-orders-row-applied" : "pos-orders-row-pending"
          )}
          data-testid={"row-transfer-" + transfer.voucherId}
        >
          <div className="pos-orders-row-main flex min-w-0 items-start gap-3">
            <span
              className={cn(
                "pos-orders-status-dot mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full",
                transfer.inventoryApplied ? "bg-green-500 dark:bg-green-400" : "bg-amber-400"
              )}
              aria-hidden="true"
            />
            <div className="pos-orders-row-info min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
                <span
                  className="break-all font-mono text-sm font-bold tracking-tight"
                  data-testid={"text-voucher-" + transfer.voucherId}
                >
                  {transfer.voucherNumber}
                </span>
                <span className="text-xs text-muted-foreground">{formatDate(transfer.voucherDate)}</span>
                {transfer.inventoryApplied ? (
                  <Badge
                    variant="secondary"
                    className="gap-1 border border-green-200 bg-green-50 text-xs text-green-700 dark:border-green-800/60 dark:bg-green-900/30 dark:text-green-300"
                    data-testid={"badge-applied-" + transfer.voucherId}
                  >
                    <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Applied
                  </Badge>
                ) : (
                  <Badge
                    variant="secondary"
                    className="gap-1 border border-amber-200 bg-amber-50 text-xs text-amber-700 dark:border-amber-800/60 dark:bg-amber-900/30 dark:text-amber-300"
                    data-testid={"badge-pending-" + transfer.voucherId}
                  >
                    <Clock className="h-3 w-3" aria-hidden="true" /> Pending
                  </Badge>
                )}
              </div>
              <div className="pos-orders-route mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                <span className="inline-flex min-w-0 items-center gap-1.5 text-muted-foreground">
                  <Store className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  <span className="wrap-break-word">{transfer.sourceLocationName}</span>
                </span>
                <ArrowRight className="h-4 w-4 shrink-0 text-violet-500 dark:text-violet-300" aria-hidden="true" />
                <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold">
                  <MapPin className="h-3.5 w-3.5 shrink-0 text-violet-600 dark:text-violet-300" aria-hidden="true" />
                  <span className="wrap-break-word">{transfer.destinationLocationName}</span>
                </span>
              </div>
            </div>
            <div className="pos-orders-row-actions flex shrink-0 items-center gap-2">
              <div className="pos-orders-count shrink-0 rounded-xl px-3 py-2 text-center">
                <div className="font-mono text-lg font-bold leading-none tabular-nums">{transfer.itemCount}</div>
                <div className="mt-1 text-[10px] font-medium uppercase tracking-wide">items</div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:flex sm:items-center">
                <Button
                  className={cn(
                    "pos-orders-view min-h-11 w-full gap-2 sm:w-auto",
                    transfer.inventoryApplied && "col-span-2"
                  )}
                  variant="outline"
                  onClick={() => openView(transfer.voucherId)}
                  data-testid={"button-view-" + transfer.voucherId}
                >
                  <Eye className="h-4 w-4" aria-hidden="true" /> View
                </Button>
                {!transfer.inventoryApplied && (
                  <Button
                    className="pos-orders-adjust min-h-11 w-full gap-2 sm:w-auto"
                    onClick={() => setEditVoucherId(transfer.voucherId)}
                    data-testid={"button-edit-" + transfer.voucherId}
                  >
                    <Pencil className="h-4 w-4" aria-hidden="true" /> Adjust
                  </Button>
                )}
              </div>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
}
