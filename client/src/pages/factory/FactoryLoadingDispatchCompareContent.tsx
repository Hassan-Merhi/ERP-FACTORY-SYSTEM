// Extracted from ./FactoryLoadingDispatchCompare.tsx
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  Package,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
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
import { EmptyState, LoadingState } from "@/components/ui/page-state";

export function FactoryLoadingDispatchCompareContent({
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
  removing,
  result,
  rows,
  s,
  search,
  selectAllMissing,
  selectedCurrent,
  selectedId,
  setFilter,
  setRemoveOpen,
  setSearch,
  setSelectedMissing,
  setVisibleCount,
  visibleCount,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState2>,
  | "allTripsEnded"
  | "canReconcile"
  | "companyId"
  | "comparison"
  | "filter"
  | "financialReconciliation"
  | "isSupervisor"
  | "missingFromLoading"
  | "navigate"
  | "orderId"
  | "refreshAllReconciliation"
  | "removing"
  | "result"
  | "rows"
  | "s"
  | "search"
  | "selectAllMissing"
  | "selectedCurrent"
  | "selectedId"
  | "setFilter"
  | "setRemoveOpen"
  | "setSearch"
  | "setSelectedMissing"
  | "setVisibleCount"
  | "visibleCount"
>) {
  return (
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
        <LoadingState title="Comparing Pending Loading with physical truck scans…" className="rounded-xl" />
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
                No targets are set per truck. This trip shows its physical scans only. Choose <strong>All trips</strong>{" "}
                to compare against Pending Loading.
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
            <Metric label="Matched" value={printNumber(s?.matchedBales ?? null)} icon={CheckCircle2} emphasis="good" />
            <Metric label="Missing" value={printNumber(s?.missingBales ?? null)} icon={FileSearch} emphasis="warning" />
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
                <EmptyState title="No dispatch records created yet." className="min-h-0 py-6" />
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
                          <span className="block truncate text-sm font-semibold">{tripLabel(trip.dispatchNumber)}</span>
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
  );
}
