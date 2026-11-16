// Extracted from ./FactoryLoadingDispatch.tsx to keep that module under the source-size cap.
import { ArrowLeft, FileSearch, FileSpreadsheet, Loader2, Plus, RefreshCw, Truck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { blankForm } from "./FactoryLoadingDispatchTripEditor";
import { useFactoryLoadingDispatchState } from "./useFactoryLoadingDispatchState";

export function FactoryLoadingDispatchSection2({
  backToLoading,
  canCreate,
  dispatchId,
  navigate,
  orderId,
  orderQuery,
  refresh,
  setCreateOpen,
  setNewTrip,
  tripsQuery,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchState>,
  | "backToLoading"
  | "canCreate"
  | "dispatchId"
  | "navigate"
  | "orderId"
  | "orderQuery"
  | "refresh"
  | "setCreateOpen"
  | "setNewTrip"
  | "tripsQuery"
>) {
  return (
    <div className="relative overflow-hidden rounded-[22px] border border-blue-200/80 bg-gradient-to-r from-white via-blue-50/90 to-sky-100/80 p-4 shadow-sm dark:border-blue-500/25 dark:from-[hsl(var(--factory-hue)_55%_16%)] dark:via-[hsl(var(--factory-hue)_64%_17%)] dark:to-[hsl(var(--factory-hue)_80%_18%)] sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/20">
            <Truck className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold tracking-tight sm:text-xl">Dispatch Management</h1>
              <Badge variant="secondary">Loading #{orderId}</Badge>
              {orderQuery.data?.containerNumber && <Badge variant="outline">{orderQuery.data.containerNumber}</Badge>}
            </div>
            <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
              Scan actual bales on each trip, then compare all trips against Pending Loading.
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" onClick={backToLoading} data-testid="button-return-to-loading">
            <ArrowLeft className="mr-1.5 h-4 w-4" /> Loading
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              navigate(
                "/factory/sales/loading/dispatch/" + orderId + (dispatchId !== null ? "/" + dispatchId : "") + "/report"
              )
            }
            data-testid="button-dispatch-reports"
          >
            <FileSpreadsheet className="mr-1.5 h-4 w-4" /> Reports & Excel
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/compare")}
            data-testid="button-compare-all-dispatches"
          >
            <FileSearch className="mr-1.5 h-4 w-4" /> Final Loading Comparison
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void refresh()}
            disabled={tripsQuery.isFetching || orderQuery.isFetching}
            data-testid="button-refresh-dispatch"
          >
            <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh
          </Button>
          {canCreate && (
            <Button
              size="sm"
              onClick={() => {
                setNewTrip(blankForm);
                setCreateOpen(true);
              }}
              data-testid="button-new-dispatch"
            >
              <Plus className="mr-1.5 h-4 w-4" /> New Dispatch
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function FactoryLoadingDispatchDialogSection({
  deleteMutation,
  deleteOpen,
  deleteReason,
  selectedTrip,
  setDeleteOpen,
  setDeleteReason,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchState>,
  "deleteMutation" | "deleteOpen" | "deleteReason" | "selectedTrip" | "setDeleteOpen" | "setDeleteReason"
>) {
  return (
    <Dialog
      open={deleteOpen}
      onOpenChange={(open) => {
        if (!deleteMutation.isPending) setDeleteOpen(open);
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Delete Dispatch #{selectedTrip?.dispatchNumber}?</DialogTitle>
          <DialogDescription>
            Delete this open dispatch from the active list, release all its verified scans and reservations, and
            preserve the audit history. The main loading, stock, customer balance and journal vouchers will not be
            changed. Previously closed or financially recorded trips cannot be deleted.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          value={deleteReason}
          rows={3}
          maxLength={500}
          placeholder="Required reason for deleting this dispatch"
          onChange={(event) => setDeleteReason(event.target.value)}
          data-testid="input-delete-dispatch-reason"
        />
        <DialogFooter>
          <Button variant="outline" disabled={deleteMutation.isPending} onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={deleteMutation.isPending || deleteReason.trim().length < 3}
            onClick={() => deleteMutation.mutate(deleteReason.trim())}
            data-testid="button-confirm-delete-dispatch"
          >
            {deleteMutation.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
            Delete Dispatch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
