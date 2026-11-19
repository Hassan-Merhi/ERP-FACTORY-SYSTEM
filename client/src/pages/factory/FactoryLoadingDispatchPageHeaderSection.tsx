// Extracted from ./FactoryLoadingDispatch.tsx to keep that module under the source-size cap.
import { FileSearch, FileSpreadsheet, Loader2, Plus, RefreshCw, Truck } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
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

export function FactoryLoadingDispatchPageHeaderSection({
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
    <PageHeader
      title="Dispatch Management"
      icon={<Truck className="h-5 w-5" />}
      subtitle="Scan actual bales on each trip, then compare all trips against Pending Loading."
      onBack={backToLoading}
      backButtonTestId="button-return-to-loading"
      meta={
        <>
          <Badge variant="secondary">Loading #{orderId}</Badge>
          {orderQuery.data?.containerNumber && <Badge variant="outline">{orderQuery.data.containerNumber}</Badge>}
        </>
      }
    >
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
          <Plus className="mr-1.5 h-4 w-4" /> Add Dispatch
        </Button>
      )}
    </PageHeader>
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
            Remove this open dispatch from the active list and release its scans and reservations. Previously ended
            trips can also be removed after reopening, as long as they have no financial records or signed
            all-truck reconciliation. Signed closure history remains saved; loading, stock and accounting are unchanged.
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
