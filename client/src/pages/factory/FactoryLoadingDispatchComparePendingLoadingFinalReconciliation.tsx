// Extracted from ./FactoryLoadingDispatchCompare.tsx to keep that module under the source-size cap.
import { AlertTriangle, Layers3, Printer, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { dispatchBase, printNumber, tripLabel } from "./FactoryLoadingDispatchCompareParts";
import { useFactoryLoadingDispatchCompareState2 } from "./FactoryLoadingDispatchCompareCardSection";

export function FactoryLoadingDispatchComparePendingLoadingFinalReconciliation({
  allTripsEnded,
  canReconcile,
  missingFromLoading,
  removing,
  selectAllMissing,
  selectedCurrent,
  setRemoveOpen,
  setSelectedMissing,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState2>,
  | "allTripsEnded"
  | "canReconcile"
  | "missingFromLoading"
  | "removing"
  | "selectAllMissing"
  | "selectedCurrent"
  | "setRemoveOpen"
  | "setSelectedMissing"
>) {
  return (
    <Card
      className="border-blue-200 bg-white dark:border-blue-500/25 dark:bg-[hsl(var(--factory-hue)_53%_13%)]"
      data-testid="pending-loading-final-reconciliation"
    >
      <CardContent className="space-y-4 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h2 className="text-base font-bold">Final Pending Loading reconciliation</h2>
            <p className="text-xs text-muted-foreground">
              These are the exact bales still in Pending Loading but not scanned on any dispatch trip. Selecting a bale
              does not change anything until you confirm removal.
            </p>
          </div>
          <Badge variant="outline">{printNumber(missingFromLoading.length)} not scanned</Badge>
        </div>
        {!allTripsEnded && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-200">
            You can review missing bales now. To remove them from Pending Loading, finish all open dispatch trips first.
          </p>
        )}
        {missingFromLoading.length === 0 ? (
          <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-200">
            No missing bale references. Every bale in the current loading is verified on a trip.
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={selectAllMissing}
                disabled={!canReconcile || removing}
                data-testid="button-select-all-missing-bales"
              >
                {selectedCurrent.length === missingFromLoading.length ? "Clear selection" : "Select all missing"}
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={!canReconcile || removing || selectedCurrent.length === 0}
                onClick={() => setRemoveOpen(true)}
                data-testid="button-remove-selected-missing-bales"
              >
                Remove {selectedCurrent.length} selected from loading
              </Button>
            </div>
            <div className="max-h-[360px] overflow-auto rounded-lg border dark:border-slate-700">
              <table className="w-full min-w-[480px] text-left text-xs">
                <thead className="sticky top-0 bg-slate-100 dark:bg-[hsl(var(--factory-hue)_58%_10%)]">
                  <tr>
                    <th className="px-3 py-2">Select</th>
                    <th className="px-3 py-2">Bale reference</th>
                    <th className="px-3 py-2">Article</th>
                    <th className="px-3 py-2 text-right">KG</th>
                  </tr>
                </thead>
                <tbody>
                  {missingFromLoading.map((bale) => (
                    <tr key={bale.orderBaleId} className="border-t dark:border-slate-700">
                      <td className="px-3 py-2">
                        <Checkbox
                          checked={selectedCurrent.includes(bale.orderBaleId!)}
                          disabled={!canReconcile || removing}
                          onCheckedChange={(value) =>
                            setSelectedMissing((ids) =>
                              value === true
                                ? [...ids.filter((id) => id !== bale.orderBaleId), bale.orderBaleId!]
                                : ids.filter((id) => id !== bale.orderBaleId)
                            )
                          }
                          aria-label={"Select missing bale " + bale.baleReference}
                        />
                      </td>
                      <td className="px-3 py-2 font-mono font-semibold">{bale.baleReference}</td>
                      <td className="px-3 py-2">
                        {bale.articleCode} <span className="text-muted-foreground">{bale.productName}</span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{printNumber(bale.weightKg, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
        <p className="text-[11px] text-muted-foreground">
          Removal is restricted to Admin, Owner and Developer, requires an approval reason, and returns only unshipped
          bales to stock in one atomic transaction. No scanned/posted bale can be removed. After signing the final order
          reconciliation, all further removals are locked.
        </p>
      </CardContent>
    </Card>
  );
}

export function FactoryLoadingDispatchCompareCardSection2({
  s,
  selectedId,
}: Pick<ReturnType<typeof useFactoryLoadingDispatchCompareState2>, "s" | "selectedId">) {
  return (
    <Card className="border-blue-100 bg-white dark:border-blue-500/20 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm font-bold">Verification progress</p>
          <p className="font-mono text-sm font-bold">
            {printNumber(s?.progressPercent ?? null)}
            {s?.progressPercent !== null && s?.progressPercent !== undefined ? "%" : ""}
          </p>
        </div>
        <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
          <div
            className="h-full rounded-full bg-blue-600 transition-[width]"
            style={{ width: (s?.progressPercent ?? 0) + "%" }}
          />
        </div>
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {selectedId
              ? "Trip scans are recorded without a per-truck target"
              : "Pending Loading weight: " + printNumber(s?.expectedWeightKg ?? null, 3) + " kg"}
          </span>
          <span>Scanned weight: {printNumber(s?.verifiedWeightKg ?? null, 3)} kg</span>
          <span>Weight difference: {printNumber(s?.weightDifferenceKg ?? null, 3)} kg</span>
          <span>
            Loading: {printNumber(s?.loadedBales ?? null)} bales · {printNumber(s?.loadedWeightKg ?? null, 3)} kg
          </span>
        </div>
        {s && s.duplicateBales > 0 && (
          <p className="flex items-center gap-2 text-xs font-semibold text-red-600">
            <AlertTriangle className="h-4 w-4" />
            {s.duplicateBales} active duplicate anomalies
          </p>
        )}
      </CardContent>
    </Card>
  );
}

export function FactoryLoadingDispatchComparePageHeaderSection({
  comparison,
  navigate,
  orderId,
  result,
  selectedId,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchCompareState2>,
  "comparison" | "navigate" | "orderId" | "result" | "selectedId"
>) {
  return (
    <PageHeader
      title="Dispatch Comparison"
      icon={<Layers3 className="h-5 w-5" />}
      backTarget={dispatchBase(orderId) + (selectedId ? "/" + selectedId : "")}
      meta={
        <>
          <Badge variant="secondary">Loading #{orderId}</Badge>
          {result?.containerNumber && <Badge variant="outline">{result.containerNumber}</Badge>}
        </>
      }
      subtitle={
        <>
          {result?.dispatch ? tripLabel(result.dispatch.dispatchNumber) : "All truck trips"} · Physical verification
          versus loaded bale references
        </>
      }
    >
      <Button
        size="sm"
        variant="outline"
        onClick={() => navigate(dispatchBase(orderId) + (selectedId ? "/" + selectedId : "") + "/report")}
        data-testid="button-compare-dispatch-report"
      >
        <Printer className="mr-1.5 h-4 w-4" /> Print / Export
      </Button>
      <Button size="sm" variant="outline" onClick={() => void comparison.refetch()} disabled={comparison.isFetching}>
        <RefreshCw className={"mr-1.5 h-4 w-4" + (comparison.isFetching ? " animate-spin" : "")} /> Refresh
      </Button>
    </PageHeader>
  );
}
