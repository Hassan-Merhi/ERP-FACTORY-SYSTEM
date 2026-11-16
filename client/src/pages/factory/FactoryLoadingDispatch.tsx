import {
  ArrowLeft,
  ArrowRight,
  ClipboardCheck,
  Clock3,
  Edit3,
  FileSearch,
  Loader2,
  Package,
  Route,
  ShieldCheck,
  Truck,
  Trash2,
  Weight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { companyQueryKey } from "@/lib/companyQueryScope";
import FactoryDispatchOrderDashboard from "./FactoryDispatchOrderDashboard";
import { queryClient } from "@/lib/queryClient";
import FactoryLoadingDispatchScanner from "./FactoryLoadingDispatchScanner";
import FactoryLoadingDispatchLifecycle from "./FactoryLoadingDispatchLifecycle";
import FactoryLoadingDispatchFinance from "./FactoryLoadingDispatchFinance";
import FactoryLoadingDispatchPostingPanel from "./FactoryLoadingDispatchPostingPanel";
import FactoryLoadingDispatchPoExport from "./FactoryLoadingDispatchPoExport";
import {
  StatCard,
  TripEditor,
  TripStatusBadge,
  fromTrip,
  getError,
  numberValue,
  printNumber,
  tripPath,
} from "./FactoryLoadingDispatchTripEditor";
import { FactoryLoadingDispatchSection, useFactoryLoadingDispatchState } from "./useFactoryLoadingDispatchState";
import {
  FactoryLoadingDispatchDialogSection,
  FactoryLoadingDispatchPageHeaderSection,
} from "./FactoryLoadingDispatchPageHeaderSection";

export default function FactoryLoadingDispatch() {
  const {
    backToLoading,
    canCreate,
    canDeleteDispatch,
    canEdit,
    canViewFinancialDashboard,
    companyId,
    completion,
    createMutation,
    createOpen,
    deleteMutation,
    deleteOpen,
    deleteReason,
    dispatchId,
    editMutation,
    editOpen,
    editTrip,
    filter,
    formatDisplayDateTime,
    listUrl,
    loadedQty,
    loadedWeight,
    navigate,
    newTrip,
    openTrips,
    orderId,
    orderQuery,
    refresh,
    remainingQty,
    selectedQuery,
    selectedTrip,
    selectedUrl,
    setCreateOpen,
    setDeleteOpen,
    setDeleteReason,
    setEditOpen,
    setEditTrip,
    setFilter,
    setNewTrip,
    trips,
    tripsQuery,
    user,
    validDispatch,
    validOrder,
    verifiedQty,
    verifiedWeight,
    visibleTrips,
  } = useFactoryLoadingDispatchState();

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

        <div className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/80 p-3 text-xs text-indigo-900 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-100">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">Scan-only dispatch.</span> No expected targets per truck. Scanning records
            the actual bales on each trip. After all trips finish, compare against Pending Loading and choose whether to
            remove unscanned bales.
          </div>
        </div>

        {(tripsQuery.isError || orderQuery.isError) && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30">
            <span>{getError(tripsQuery.error ?? orderQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>
              Retry
            </Button>
          </div>
        )}

        <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
          <StatCard label="Loaded bales" value={printNumber(loadedQty)} icon={Package} />
          <StatCard label="Verified on trips" value={printNumber(verifiedQty)} icon={ClipboardCheck} />
          <StatCard label="Not yet verified" value={printNumber(remainingQty)} icon={FileSearch} />
          <StatCard label="Open dispatches" value={printNumber(openTrips)} icon={Truck} />
        </div>

        <Card className="border-blue-100 bg-white dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">Overall truck verification</span>
              <span className="font-mono text-sm font-bold">{completion}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: completion + "%" }} />
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>
                Loading: {printNumber(loadedQty)} bales · {printNumber(loadedWeight, 2)} kg
              </span>
              <span>
                Truck verified: {printNumber(verifiedQty)} bales · {printNumber(verifiedWeight, 2)} kg
              </span>
            </div>
          </CardContent>
        </Card>

        {dispatchId === null && canViewFinancialDashboard && (
          <ErrorBoundary resetKey={"factory-dispatch-overview-" + orderId}>
            <FactoryDispatchOrderDashboard
              orderId={orderId}
              companyId={companyId}
              onOpenTrip={(tripId) => navigate(tripPath(orderId, tripId))}
              onCompareAll={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/compare")}
              onPhysicalReport={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/report")}
            />
          </ErrorBoundary>
        )}

        {dispatchId === null ? (
          <FactoryLoadingDispatchSection
            canCreate={canCreate}
            filter={filter}
            formatDisplayDateTime={formatDisplayDateTime}
            navigate={navigate}
            openTrips={openTrips}
            orderId={orderId}
            setCreateOpen={setCreateOpen}
            setFilter={setFilter}
            trips={trips}
            tripsQuery={tripsQuery}
            visibleTrips={visibleTrips}
          />
        ) : (
          <div className="space-y-4">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => navigate(tripPath(orderId))}
              data-testid="button-dispatch-back"
            >
              <ArrowLeft className="mr-1.5 h-4 w-4" /> All dispatches
            </Button>
            {selectedQuery.isPending && !selectedTrip && (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading trip details…
              </div>
            )}
            {selectedQuery.isError && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30">
                {getError(selectedQuery.error)}
              </div>
            )}
            {selectedTrip && dispatchId !== null && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(290px,0.7fr)]">
                <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
                  <CardContent className="space-y-5 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg font-bold">
                            Dispatch #{String(selectedTrip.dispatchNumber).padStart(3, "0")}
                          </h2>
                          <TripStatusBadge status={selectedTrip.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Opened {formatDisplayDateTime(selectedTrip.createdAt)} by{" "}
                          {selectedTrip.createdByUsername || "Unknown"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {canDeleteDispatch && selectedTrip.status === "OPEN" && (
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => {
                              setDeleteReason("");
                              setDeleteOpen(true);
                            }}
                            data-testid="button-delete-dispatch"
                          >
                            <Trash2 className="mr-1.5 h-4 w-4" /> Delete Dispatch
                          </Button>
                        )}
                        {canEdit && selectedTrip.status === "OPEN" && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => {
                              setEditTrip(fromTrip(selectedTrip));
                              setEditOpen(true);
                            }}
                            data-testid="button-edit-dispatch"
                          >
                            <Edit3 className="mr-1.5 h-4 w-4" /> Edit details
                          </Button>
                        )}
                      </div>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {(
                        [
                          ["Trip number", String(selectedTrip.dispatchNumber)],
                          [
                            "Container",
                            selectedTrip.containerNumberSnapshot || tripsQuery.data?.containerNumber || "Not assigned",
                          ],
                        ] as const
                      ).map(([label, value]) => (
                        <div
                          key={label}
                          className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700"
                        >
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                          <p className="mt-1 break-words text-sm font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>
                    {selectedTrip.notes && (
                      <div className="rounded-xl bg-slate-50 p-3 dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Notes</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{selectedTrip.notes}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 border-t pt-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1">
                        <Package className="h-3.5 w-3.5" />{" "}
                        {printNumber(
                          numberValue(
                            selectedTrip.scannedBales ??
                              trips.find((trip) => Number(trip.id) === dispatchId)?.scannedBales
                          )
                        )}{" "}
                        scans
                      </span>
                      <span className="flex items-center gap-1">
                        <Weight className="h-3.5 w-3.5" />{" "}
                        {printNumber(
                          numberValue(
                            selectedTrip.scannedWeightKg ??
                              trips.find((trip) => Number(trip.id) === dispatchId)?.scannedWeightKg
                          ),
                          2
                        )}{" "}
                        kg
                      </span>
                      <span className="flex items-center gap-1">
                        <Clock3 className="h-3.5 w-3.5" />{" "}
                        {selectedTrip.status === "OPEN" ? "Barcode verification active" : "Trip finished"}
                      </span>
                    </div>
                  </CardContent>
                </Card>
                <div className="space-y-3">
                  <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center gap-2">
                        <Route className="h-4 w-4 text-blue-500" />
                        <h3 className="text-sm font-semibold">Truck verification</h3>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Use the scanner below for each bale entering this truck. Scans never change the main loading.
                      </p>
                      <Badge variant="secondary">Scanner available below</Badge>
                    </CardContent>
                  </Card>
                  <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center gap-2">
                        <FileSearch className="h-4 w-4 text-blue-500" />
                        <h3 className="text-sm font-semibold">Final loading comparison</h3>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Compare every trip's scanned bales against Pending Loading. After all trips finish, you may
                        choose which unscanned bales to remove from the order.
                      </p>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="w-full justify-between"
                        onClick={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/compare")}
                        data-testid="button-compare-dispatch"
                      >
                        Compare all trips <ArrowRight className="h-4 w-4" />
                      </Button>
                    </CardContent>
                  </Card>
                  <ErrorBoundary resetKey={"dispatch-lifecycle-" + dispatchId}>
                    <FactoryLoadingDispatchLifecycle
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={user?.currentRole ?? user?.role ?? ""}
                      onChanged={() => {
                        void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
                        if (selectedUrl)
                          void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
                      }}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary resetKey={"dispatch-finance-" + dispatchId}>
                    <FactoryLoadingDispatchFinance
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={user?.currentRole ?? user?.role ?? ""}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary resetKey={"dispatch-posting-" + dispatchId}>
                    <FactoryLoadingDispatchPostingPanel
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={user?.currentRole ?? user?.role ?? ""}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary resetKey={"dispatch-po-export-" + dispatchId}>
                    <FactoryLoadingDispatchPoExport
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={user?.currentRole ?? user?.role ?? ""}
                    />
                  </ErrorBoundary>
                </div>
                <div className="xl:col-span-2">
                  <FactoryLoadingDispatchScanner
                    key={dispatchId}
                    orderId={orderId}
                    dispatchId={dispatchId}
                    companyId={companyId}
                    status={selectedTrip.status}
                    role={user?.currentRole ?? user?.role ?? ""}
                    onChanged={() => {
                      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
                      if (selectedUrl)
                        void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 text-xs text-muted-foreground dark:border-slate-700">
          <ShieldCheck className="h-4 w-4" /> Separate truck records · Same loading order · Draft charge previews do not
          post stock or accounting changes
        </div>
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
