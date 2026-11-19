import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import FactoryLoadingDispatchOverview from "./FactoryLoadingDispatchOverview";
import FactoryLoadingDispatchDetail from "./FactoryLoadingDispatchDetail";
import { TripEditor, getError } from "./FactoryLoadingDispatchTripEditor";
import { useFactoryLoadingDispatchState } from "./useFactoryLoadingDispatchState";
import {
  FactoryLoadingDispatchDialogSection,
  FactoryLoadingDispatchPageHeaderSection,
} from "./FactoryLoadingDispatchPageHeaderSection";

export default function FactoryLoadingDispatch() {
  const state = useFactoryLoadingDispatchState();
  const {
    backToLoading,
    canCreate,
    canEdit,
    createMutation,
    createOpen,
    deleteMutation,
    deleteOpen,
    deleteReason,
    dispatchId,
    editMutation,
    editOpen,
    editTrip,
    orderId,
    orderQuery,
    refresh,
    selectedQuery,
    selectedTrip,
    setCreateOpen,
    setDeleteOpen,
    setDeleteReason,
    setEditOpen,
    setEditTrip,
    setNewTrip,
    newTrip,
    tripsQuery,
    validDispatch,
    validOrder,
    navigate,
  } = state;

  if (!validOrder || !validDispatch) {
    return <div className="p-6 text-sm text-destructive">Invalid loading order or dispatch ID.</div>;
  }

  return (
    <div
      className="flex h-full min-w-0 flex-col overflow-y-auto bg-slate-50/70 dark:bg-[hsl(var(--factory-hue)_56%_7%)]"
      data-testid="factory-loading-dispatch-page"
    >
      <div className="mx-auto w-full max-w-[1480px] space-y-5 p-3 pb-10 sm:p-5 lg:p-7">
        <FactoryLoadingDispatchPageHeaderSection
          backToLoading={backToLoading}
          canCreate={canCreate}
          dispatchId={dispatchId}
          navigate={navigate}
          orderId={orderId}
          orderQuery={orderQuery}
          refresh={refresh}
          setCreateOpen={setCreateOpen}
          setNewTrip={setNewTrip}
          tripsQuery={tripsQuery}
        />

        {(tripsQuery.isError || orderQuery.isError) && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30">
            <span>{getError(tripsQuery.error ?? orderQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        )}

        {dispatchId === null ? (
          <FactoryLoadingDispatchOverview state={state} />
        ) : (
          <div className="space-y-4">
            {selectedQuery.isPending && !selectedTrip && (
              <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading trip details…
              </p>
            )}
            {selectedQuery.isError && (
              <p
                role="alert"
                className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30"
              >
                {getError(selectedQuery.error)}
              </p>
            )}
            {selectedTrip && <FactoryLoadingDispatchDetail state={state} />}
          </div>
        )}
      </div>

      <FactoryLoadingDispatchDialogSection
        deleteMutation={deleteMutation}
        deleteOpen={deleteOpen}
        deleteReason={deleteReason}
        selectedTrip={selectedTrip}
        setDeleteOpen={setDeleteOpen}
        setDeleteReason={setDeleteReason}
      />
      <TripEditor
        open={createOpen}
        onOpenChange={(open) => {
          if (!createMutation.isPending) setCreateOpen(open);
        }}
        value={newTrip}
        onChange={setNewTrip}
        title="New dispatch"
        submitLabel="Create dispatch"
        busy={createMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (canCreate) createMutation.mutate(newTrip);
        }}
      />
      <TripEditor
        open={editOpen}
        onOpenChange={(open) => {
          if (!editMutation.isPending) setEditOpen(open);
        }}
        value={editTrip}
        onChange={setEditTrip}
        title="Edit dispatch details"
        submitLabel="Save changes"
        busy={editMutation.isPending}
        onSubmit={(event) => {
          event.preventDefault();
          if (canEdit && selectedTrip?.status === "OPEN") editMutation.mutate(editTrip);
        }}
      />
    </div>
  );
}
