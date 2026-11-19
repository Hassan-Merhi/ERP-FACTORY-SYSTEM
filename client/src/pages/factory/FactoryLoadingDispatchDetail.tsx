import { useState } from "react";
import {
  ArrowRight,
  ChevronDown,
  ClipboardCheck,
  Edit3,
  Package,
  RefreshCw,
  ScanLine,
  Trash2,
  Truck,
  Weight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { queryClient } from "@/lib/queryClient";
import FactoryLoadingDispatchScanner from "./FactoryLoadingDispatchScanner";
import FactoryLoadingDispatchLifecycle from "./FactoryLoadingDispatchLifecycle";
import FactoryLoadingDispatchFinance from "./FactoryLoadingDispatchFinance";
import FactoryLoadingDispatchPostingPanel from "./FactoryLoadingDispatchPostingPanel";
import { fromTrip, numberValue, printNumber, TripStatusBadge, tripPath } from "./FactoryLoadingDispatchTripEditor";
import { useFactoryLoadingDispatchState } from "./useFactoryLoadingDispatchState";

type State = ReturnType<typeof useFactoryLoadingDispatchState>;

export default function FactoryLoadingDispatchDetail({ state }: { state: State }) {
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const {
    canDeleteDispatch,
    canEdit,
    canViewFinancialDashboard,
    companyId,
    completion,
    dispatchId,
    formatDisplayDateTime,
    listUrl,
    loadedQty,
    loadedWeight,
    navigate,
    orderId,
    refresh,
    remainingQty,
    selectedTrip,
    selectedUrl,
    setDeleteOpen,
    setDeleteReason,
    setEditOpen,
    setEditTrip,
    trips,
    tripsQuery,
    user,
    verifiedQty,
    verifiedWeight,
  } = state;

  if (!selectedTrip || dispatchId === null) return null;

  const tripInList = trips.find((trip) => Number(trip.id) === dispatchId);
  const scanned = numberValue(selectedTrip.scannedBales ?? tripInList?.scannedBales);
  const weight = numberValue(selectedTrip.scannedWeightKg ?? tripInList?.scannedWeightKg);
  const role = user?.currentRole ?? user?.role ?? "";
  const onChanged = () => {
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
    if (selectedUrl) {
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
    }
  };
  const onRefresh = () => {
    void refresh();
    if (selectedUrl) {
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl + "/scans", companyId) });
    }
  };
  const compare = () => navigate(tripPath(orderId) + "/compare");

  const metrics = [
    { label: "Loaded bales", value: printNumber(loadedQty), icon: Package },
    { label: "Scanned on trip", value: printNumber(scanned), icon: ScanLine },
    { label: "Remaining on loading", value: printNumber(remainingQty), icon: ClipboardCheck },
  ] as const;

  return (
    <div className="space-y-4" data-testid="dispatch-simplified-trip-detail">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div key={label} className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
            <span className="rounded-lg bg-blue-500/10 p-2 text-blue-600 dark:text-blue-300">
              <Icon className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <p className="text-xs text-muted-foreground">{label}</p>
              <strong className="font-mono text-xl sm:text-2xl">{value}</strong>
            </div>
          </div>
        ))}
        <div className="flex min-w-0 items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-sm sm:p-4">
          <span className="rounded-lg bg-blue-500/10 p-2 text-blue-600 dark:text-blue-300">
            <Truck className="h-5 w-5" />
          </span>
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Trip status</p>
            <TripStatusBadge status={selectedTrip.status} />
          </div>
        </div>
      </div>

      <Card className="border-border bg-card shadow-sm">
        <CardContent className="space-y-2 p-3 sm:p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Overall scan progress</p>
            <span className="font-mono text-sm font-semibold">{completion}%</span>
          </div>
          <div role="progressbar" aria-label="Overall loading scan progress"
            aria-valuenow={completion} aria-valuemin={0} aria-valuemax={100}
            className="h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-blue-500 transition-all"
              style={{ width: completion + "%" }} />
          </div>
          <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
            <span>{printNumber(verifiedQty)} / {printNumber(loadedQty)} loading bales scanned across trips</span>
            <span>{printNumber(verifiedWeight, 2)} / {printNumber(loadedWeight, 2)} kg</span>
          </div>
        </CardContent>
      </Card>

      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_310px]">
        <Card className="min-w-0 overflow-hidden border-border bg-card shadow-sm">
          <CardContent className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-lg font-bold sm:text-xl">
                    Dispatch #{String(selectedTrip.dispatchNumber).padStart(3, "0")}
                  </h2>
                  <TripStatusBadge status={selectedTrip.status} />
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Created {formatDisplayDateTime(selectedTrip.createdAt)} by {selectedTrip.createdByUsername || "Unknown"}
                </p>
              </div>
            </div>
            <div className="grid gap-3 border-b border-border pb-4 text-sm sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Trip number</p>
                <p className="mt-1 font-semibold">{selectedTrip.dispatchNumber}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Container</p>
                <p className="mt-1 break-words font-semibold">
                  {selectedTrip.containerNumberSnapshot || tripsQuery.data?.containerNumber || "Not assigned"}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Created by</p>
                <p className="mt-1 font-semibold">{selectedTrip.createdByUsername || "Unknown"}</p>
              </div>
            </div>
            {selectedTrip.notes && (
              <p className="rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
                {selectedTrip.notes}
              </p>
            )}
            <FactoryLoadingDispatchScanner
              key={dispatchId}
              orderId={orderId}
              dispatchId={dispatchId}
              companyId={companyId}
              status={selectedTrip.status}
              role={role}
              onChanged={onChanged}
              embedded
            />
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className="border-border bg-card shadow-sm">
            <CardContent className="space-y-3 p-4">
              <h3 className="font-semibold">Quick actions</h3>
              <Button className="w-full justify-between" onClick={compare}
                data-testid="button-compare-dispatch">
                Final comparison <ArrowRight className="h-4 w-4" />
              </Button>
              <ErrorBoundary resetKey={"dispatch-lifecycle-" + dispatchId}>
                <FactoryLoadingDispatchLifecycle
                  key={dispatchId}
                  orderId={orderId}
                  dispatchId={dispatchId}
                  companyId={companyId}
                  status={selectedTrip.status}
                  role={role}
                  onChanged={onChanged}
                  compact
                />
              </ErrorBoundary>
              <Button type="button" variant="outline" className="w-full justify-start"
                onClick={onRefresh} data-testid="button-refresh-trip-detail">
                <RefreshCw className="mr-2 h-4 w-4" /> Refresh
              </Button>
            </CardContent>
          </Card>

          <Card className="border-border bg-card shadow-sm">
            <CardContent className="space-y-3 p-4">
              <h3 className="font-semibold">Trip summary</h3>
              <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 text-sm">
                <span className="flex items-center gap-2"><Package className="h-4 w-4" /> Scanned bales</span>
                <strong className="font-mono">{printNumber(scanned)}</strong>
              </div>
              <div className="flex items-center justify-between rounded-lg bg-muted/30 p-3 text-sm">
                <span className="flex items-center gap-2"><Weight className="h-4 w-4" /> Scanned weight</span>
                <strong className="font-mono">{printNumber(weight, 2)} kg</strong>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {(canEdit || canViewFinancialDashboard || canDeleteDispatch) && (
        <div className="overflow-hidden rounded-xl border border-border bg-card" data-testid="dispatch-advanced-trip-controls">
          <button type="button" onClick={() => setAdvancedOpen(!advancedOpen)}
            className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left text-sm font-medium hover:bg-muted/30"
            aria-expanded={advancedOpen} data-testid="dispatch-toggle-trip-options">
            <span>Trip finances & more options</span>
            <ChevronDown className={"h-4 w-4 transition-transform " + (advancedOpen ? "rotate-180" : "")} />
          </button>
          {advancedOpen && (
            <div className="space-y-4 border-t border-border p-4">
              {(canEdit || canDeleteDispatch) && selectedTrip.status === "OPEN" && (
                <div className="flex flex-wrap gap-2">
                  {canEdit && (
                    <Button size="sm" variant="outline" onClick={() => {
                      setEditTrip(fromTrip(selectedTrip));
                      setEditOpen(true);
                    }} data-testid="button-edit-dispatch">
                      <Edit3 className="mr-1.5 h-4 w-4" /> Edit details
                    </Button>
                  )}
                  {canDeleteDispatch && (
                    <Button size="sm" variant="destructive" onClick={() => {
                      setDeleteReason("");
                      setDeleteOpen(true);
                    }} data-testid="button-delete-dispatch">
                      <Trash2 className="mr-1.5 h-4 w-4" /> Delete dispatch
                    </Button>
                  )}
                </div>
              )}
              {canViewFinancialDashboard && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <ErrorBoundary resetKey={"dispatch-finance-" + dispatchId}>
                    <FactoryLoadingDispatchFinance
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={role}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary resetKey={"dispatch-posting-" + dispatchId}>
                    <FactoryLoadingDispatchPostingPanel
                      key={dispatchId}
                      orderId={orderId}
                      dispatchId={dispatchId}
                      companyId={companyId}
                      status={selectedTrip.status}
                      role={role}
                    />
                  </ErrorBoundary>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
