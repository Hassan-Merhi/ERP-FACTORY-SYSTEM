import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  Loader2,
  Package,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import FactoryDispatchOrderFinancialReview from "./FactoryDispatchOrderFinancialReview";

import { printNumber, tripLabel, comparePath, Metric, Findings } from "./FactoryLoadingDispatchCompareParts";
import {
  FactoryLoadingDispatchCompareCardSection,
  useFactoryLoadingDispatchCompareState2,
} from "./FactoryLoadingDispatchCompareCardSection";
import {
  FactoryLoadingDispatchCompareCardSection2,
  FactoryLoadingDispatchComparePageHeaderSection,
  FactoryLoadingDispatchComparePendingLoadingFinalReconciliation,
} from "./FactoryLoadingDispatchComparePendingLoadingFinalReconciliation";

export default function FactoryLoadingDispatchCompare() {
  const {
    allTripsEnded,
    canReconcile,
    companyId,
    comparison,
    filter,
    financialReconciliation,
    isSupervisor,
    missingFromLoading,
    navigate,
    orderId,
    refreshAllReconciliation,
    removalReason,
    removeConfirmed,
    removeOpen,
    removeSelected,
    removing,
    result,
    rows,
    s,
    search,
    selectAllMissing,
    selectedCurrent,
    selectedId,
    selectedKg,
    setFilter,
    setRemovalReason,
    setRemoveConfirmed,
    setRemoveOpen,
    setSearch,
    setSelectedMissing,
    setVisibleCount,
    valid,
    visibleCount,
  } = useFactoryLoadingDispatchCompareState2();

  if (!valid) {
    return <div className="p-6 text-sm text-destructive">Invalid loading or dispatch number.</div>;
  }

  return (
    <div
      className="h-full min-w-0 overflow-y-auto bg-slate-50/80 p-3 pb-10 dark:bg-[hsl(var(--factory-hue)_56%_7%)] sm:p-5 lg:p-7"
      data-testid="factory-dispatch-comparison-page"
    >
      <div className="mx-auto max-w-[1480px] space-y-4">
        <FactoryLoadingDispatchComparePageHeaderSection
          comparison={comparison}
          navigate={navigate}
          orderId={orderId}
          result={result}
          selectedId={selectedId}
        />

        {comparison.isError && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/20">
            <span>{comparison.error instanceof Error ? comparison.error.message : "Unable to load comparison"}</span>
            <Button size="sm" variant="outline" onClick={() => void comparison.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {comparison.isPending && (
          <div className="flex items-center gap-2 rounded-xl border p-5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Comparing Pending Loading with physical truck scans…
          </div>
        )}

        {result && (
          <>
            <div className="overflow-x-auto pb-1">
              <TabsList className="w-max" aria-label="Compare all trucks or an individual dispatch">
                <PillTabButton
                  selected={selectedId === undefined}
                  onClick={() => {
                    setFilter("all");
                    setSearch("");
                    navigate(comparePath(orderId));
                  }}
                >
                  All trips
                </PillTabButton>
                {result.trips.map((trip) => (
                  <PillTabButton
                    key={trip.id}
                    selected={selectedId === String(trip.id)}
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                      navigate(comparePath(orderId, String(trip.id)));
                    }}
                  >
                    #{String(trip.dispatchNumber).padStart(3, "0")} · {trip.scannedBales}
                  </PillTabButton>
                ))}
              </TabsList>
            </div>

            {!selectedId ? (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-sky-200">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Pending Loading is the master bale list. After every trip ends, compare all scanned references against
                  it and choose which unscanned bales to remove.
                </p>
              </div>
            ) : !result.hasTripPlan ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  No targets are set per truck. This trip shows its physical scans only. Choose{" "}
                  <strong>All trips</strong> to compare against Pending Loading.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-sky-200">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  This trip shows its physical scans only. The missing-bale comparison comes from all completed trips
                  versus Pending Loading.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
              <Metric label="Pending Loading" value={printNumber(s?.loadedBales ?? null)} icon={Package} />
              <Metric label="Verified" value={printNumber(s?.verifiedBales ?? null)} icon={Truck} />
              <Metric
                label="Matched"
                value={printNumber(s?.matchedBales ?? null)}
                icon={CheckCircle2}
                emphasis="good"
              />
              <Metric
                label="Missing"
                value={printNumber(s?.missingBales ?? null)}
                icon={FileSearch}
                emphasis="warning"
              />
              <Metric
                label="Unexpected refs"
                value={printNumber(s?.unexpectedBales ?? null)}
                icon={AlertTriangle}
                emphasis="warning"
              />
            </div>

            {!selectedId && (
              <FactoryDispatchOrderFinancialReview
                value={financialReconciliation.data ?? null}
                loading={financialReconciliation.isPending}
                error={
                  financialReconciliation.isError
                    ? financialReconciliation.error instanceof Error
                      ? financialReconciliation.error.message
                      : "Financial reconciliation unavailable"
                    : null
                }
                orderId={orderId}
                companyId={companyId}
                isSupervisor={isSupervisor}
                onRefresh={refreshAllReconciliation}
              />
            )}

            {!selectedId && (
              <FactoryLoadingDispatchComparePendingLoadingFinalReconciliation
                allTripsEnded={allTripsEnded}
                canReconcile={canReconcile}
                missingFromLoading={missingFromLoading}
                removing={removing}
                selectAllMissing={selectAllMissing}
                selectedCurrent={selectedCurrent}
                setRemoveOpen={setRemoveOpen}
                setSelectedMissing={setSelectedMissing}
              />
            )}

            <FactoryLoadingDispatchCompareCardSection2 s={s} selectedId={selectedId} />

            <FactoryLoadingDispatchCompareCardSection
              filter={filter}
              rows={rows}
              search={search}
              setFilter={setFilter}
              setSearch={setSearch}
              setVisibleCount={setVisibleCount}
              visibleCount={visibleCount}
            />

            <div className="grid gap-4 xl:grid-cols-2">
              {selectedId && (
                <Findings
                  key={"missing-" + selectedId}
                  title="Missing bale references"
                  subtitle="Use All Trips to review the missing bale references from Pending Loading"
                  items={result.missingBales}
                  kind="missing"
                  orderId={orderId}
                />
              )}
              <Findings
                key={"unexpected-" + selectedId}
                title="Unexpected scanned references"
                subtitle="Scanned bales that are no longer in Pending Loading"
                items={result.unexpectedBales}
                kind="unexpected"
                orderId={orderId}
              />

              {result.duplicateBales.length > 0 && (
                <Findings
                  title="Duplicate active scan anomalies"
                  subtitle="Unexpected duplicate records despite database safeguards"
                  items={result.duplicateBales}
                  kind="duplicate"
                  orderId={orderId}
                />
              )}
            </div>

            <Card className="border-slate-200 dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
              <CardContent className="space-y-3 p-4">
                <h3 className="text-sm font-bold">All truck trips</h3>
                {result.trips.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No dispatch records created yet.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {result.trips.map((trip) => (
                      <button
                        key={trip.id}
                        type="button"
                        onClick={() => navigate(comparePath(orderId, String(trip.id)))}
                        className="flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors hover:border-blue-400 hover:bg-blue-50/60 dark:border-slate-700 dark:hover:bg-blue-500/10"
                        data-testid={"compare-trip-" + trip.id}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Truck className="h-4 w-4 shrink-0 text-blue-500" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">
                              {tripLabel(trip.dispatchNumber)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{trip.status}</span>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 font-mono text-xs">
                          {trip.scannedBales} <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-xs text-muted-foreground dark:border-slate-700">
              <ShieldCheck className="h-4 w-4" />
              Scans are verification-only. Only a separately confirmed missing-bale removal changes Pending Loading.
            </div>
          </>
        )}
      </div>
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!removing) setRemoveOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm missing-bale removal</DialogTitle>
            <DialogDescription>
              Remove {selectedCurrent.length} unscanned bale(s), totalling {printNumber(selectedKg, 3)} kg, from Pending
              Loading? They will return to stock using the existing loading correction process. Dispatch scan history
              remains unchanged.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="dispatch-shortfall-reason">Reason for removing the unshipped bales</Label>
            <Textarea
              id="dispatch-shortfall-reason"
              rows={3}
              maxLength={1000}
              value={removalReason}
              onChange={(e) => setRemovalReason(e.target.value)}
              placeholder="All trucks are closed; these bales were never physically loaded…"
            />
            <label className="flex items-start gap-2 rounded-md border p-3 text-xs">
              <Checkbox checked={removeConfirmed} onCheckedChange={(v) => setRemoveConfirmed(v === true)} />
              <span>
                I reviewed the selected exact bale references and authorize returning only unshipped bales to stock as
                one atomic correction.
              </span>
            </label>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={removing} onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={
                !canReconcile ||
                removing ||
                selectedCurrent.length === 0 ||
                removalReason.trim().length < 10 ||
                removalReason.trim().length > 1000 ||
                !removeConfirmed
              }
              onClick={() => void removeSelected()}
              data-testid="button-confirm-remove-missing-bales"
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
