import { ClipboardList, Lock, Play, RotateCcw, Undo2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { RetailNav } from "./RetailNav";
import {
  LINE_STATUS_LABELS,
  STATUS_LABELS,
  lineStatusClass,
  statusClass,
  useRetailStockCountState,
} from "./useRetailStockCountState";
import {
  RetailStockCountCardSection,
  RetailStockCountCardSection2,
  RetailStockCountSection,
  RetailStockCountSection3,
} from "./RetailStockCountCardSection";

/**
 * Physical stock count workspace.
 *
 * Sessions move Draft → Counting → Review → Finalized (with an optional Recount loop).
 * Cashiers scan barcodes repeatedly or key quantities; finalization writes one
 * `retail_stock_movements` row per counted line and is atomic + idempotent.
 */
export default function RetailStockCount() {
  const {
    allowUncounted,
    canChangeCounts,
    canCount,
    confirmVariance,
    createMutation,
    exportStockCountCsv,
    exportingCsv,
    finalizeMutation,
    finalizeNotes,
    finalizeOpen,
    includeAllVariants,
    lineMutation,
    lines,
    locationId,
    locations,
    recordChanges,
    report,
    retailEnabled,
    scanMutation,
    scanRef,
    scanText,
    selectedId,
    session,
    sessionsQuery,
    setAllowUncounted,
    setConfirmVariance,
    setFinalizeNotes,
    setFinalizeOpen,
    setIncludeAllVariants,
    setLocationId,
    setScanText,
    setSelectedId,
    transitionMutation,
    varianceQuery,
  } = useRetailStockCountState();

  if (!retailEnabled) return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      <RetailNav />
      <PageHeader
        title="Physical stock count"
        icon={<ClipboardList className="h-6 w-6" />}
        subtitle="Snapshot expected quantities, scan or key what is on the shelf, review variances, then finalize — inventory only changes through the movements written at finalization."
      />
      <RetailStockCountSection3
        createMutation={createMutation}
        includeAllVariants={includeAllVariants}
        locationId={locationId}
        locations={locations}
        recordChanges={recordChanges}
        setIncludeAllVariants={setIncludeAllVariants}
        setLocationId={setLocationId}
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <RetailStockCountCardSection2
          selectedId={selectedId}
          sessionsQuery={sessionsQuery}
          setSelectedId={setSelectedId}
        />

        <div className="space-y-4">
          {!session ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Start a count or pick a session to continue.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="space-y-3 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <span data-no-translate>{session.code}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-normal", statusClass(session.status))}>
                      {STATUS_LABELS[session.status] ?? session.status}
                    </span>
                  </CardTitle>
                  <div className="flex flex-wrap gap-2">
                    {canChangeCounts && session.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "start" })}
                        data-testid="stock-count-start"
                      >
                        <Play className="mr-1 h-3.5 w-3.5" /> Start counting
                      </Button>
                    )}
                    {canChangeCounts && session.status === "counting" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "review" })}
                        data-testid="stock-count-review"
                      >
                        Send to review
                      </Button>
                    )}
                    {canChangeCounts && (session.status === "review" || session.status === "counting") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "recount" })}
                        data-testid="stock-count-recount"
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" /> Recount flagged
                      </Button>
                    )}
                    {canChangeCounts && session.status !== "finalized" && session.status !== "canceled" && (
                      <>
                        <Button size="sm" onClick={() => setFinalizeOpen(true)} data-testid="stock-count-finalize-open">
                          <Lock className="mr-1 h-3.5 w-3.5" /> Finalize
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => transitionMutation.mutate({ action: "cancel" })}
                        >
                          <Undo2 className="mr-1 h-3.5 w-3.5" /> Cancel
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded-sm border p-2">
                    <div className="text-muted-foreground">Lines</div>
                    <strong>{session.lineCount}</strong>
                  </div>
                  <div className="rounded-sm border p-2">
                    <div className="text-muted-foreground">Counted</div>
                    <strong>
                      {session.countedLineCount}
                      {session.uncountedLineCount > 0 ? ` · ${session.uncountedLineCount} uncounted` : ""}
                    </strong>
                  </div>
                  <div className="rounded-sm border p-2">
                    <div className="text-muted-foreground">Variance</div>
                    <strong className={session.varianceQuantityTotal !== 0 ? "text-amber-700 dark:text-amber-400" : ""}>
                      {session.varianceQuantityTotal} · {session.varianceValueTotal}
                    </strong>
                  </div>
                  <div className="rounded-sm border p-2">
                    <div className="text-muted-foreground">Unexpected</div>
                    <strong>{session.unexpectedLineCount}</strong>
                  </div>
                </div>
                {canCount && (
                  <RetailStockCountSection
                    scanMutation={scanMutation}
                    scanRef={scanRef}
                    scanText={scanText}
                    setScanText={setScanText}
                  />
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="p-2">Product</th>
                        <th className="p-2">Color</th>
                        <th className="p-2">Size</th>
                        <th className="p-2">Barcode</th>
                        <th className="p-2 text-right">Expected</th>
                        <th className="p-2 text-right">Counted</th>
                        <th className="p-2 text-right">Difference</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Notes</th>
                        <th className="p-2">Recount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => {
                        const difference =
                          line.countedQuantity === null
                            ? null
                            : Number((line.countedQuantity - line.expectedQuantity).toFixed(6));
                        return (
                          <tr key={line.id} className="border-b last:border-0" data-testid="stock-count-line">
                            <td className="p-2" data-no-translate>
                              <div className="font-medium">{line.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {line.brand} · {line.code}
                              </div>
                            </td>
                            <td className="p-2" data-no-translate>
                              {line.color}
                            </td>
                            <td className="p-2" data-no-translate>
                              {line.size}
                            </td>
                            <td className="p-2 text-xs" data-no-translate>
                              {line.barcode}
                            </td>
                            <td className="p-2 text-right">{line.expectedQuantity}</td>
                            <td className="p-2 text-right">
                              {canCount ? (
                                <Input
                                  type="number"
                                  min="0"
                                  step="1"
                                  defaultValue={line.countedQuantity ?? ""}
                                  className="h-8 w-24 text-right"
                                  onBlur={(event) => {
                                    const raw = event.target.value;
                                    if (raw === "") return;
                                    const value = Number(raw);
                                    if (!Number.isFinite(value) || value < 0) return;
                                    if (value === line.countedQuantity) return;
                                    lineMutation.mutate({ line, countedQuantity: value });
                                  }}
                                  data-testid="stock-count-line-quantity"
                                />
                              ) : (
                                (line.countedQuantity ?? "—")
                              )}
                            </td>
                            <td className={cn("p-2 text-right", difference ? "font-medium" : "")}>
                              {difference === null ? "—" : difference > 0 ? `+${difference}` : difference}
                            </td>
                            <td className={cn("p-2", lineStatusClass(line.status))}>
                              {LINE_STATUS_LABELS[line.status]}
                              {line.recountRequired && <span className="ml-1 text-xs">· recount</span>}
                            </td>
                            <td className="p-2 text-xs text-muted-foreground" data-no-translate>
                              {line.notes ?? ""}
                            </td>
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={line.recountRequired}
                                disabled={
                                  !canChangeCounts || session.status === "finalized" || session.status === "canceled"
                                }
                                onChange={(event) =>
                                  lineMutation.mutate({ line, recountRequired: event.target.checked })
                                }
                                data-testid="stock-count-line-recount"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!lines.length && (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No lines yet — send the draft into counting to snapshot expected quantities.
                  </div>
                )}
                {session.status === "finalized" && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-testid="stock-count-finalized">
                    Finalized {session.finalizedAt ? new Date(session.finalizedAt).toLocaleString() : ""} ·{" "}
                    {session.movementCount ?? session.countedLineCount} movements written to the ledger
                    {session.varianceLineCount ? ` · ${session.varianceLineCount} variance lines` : ""}.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {session?.status === "finalized" && varianceQuery.data && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Variance report — {session.code}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="p-2">Product</th>
                      <th className="p-2 text-right">Snapshot</th>
                      <th className="p-2 text-right">Counted</th>
                      <th className="p-2 text-right">Count variance</th>
                      <th className="p-2 text-right">Sales during count</th>
                      <th className="p-2 text-right">Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {varianceQuery.data.lines.map((line) => (
                      <tr key={line.id} className="border-b last:border-0" data-no-translate>
                        <td className="p-2">
                          <div className="font-medium">{line.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {line.color} · {line.size} · {line.barcode}
                          </div>
                        </td>
                        <td className="p-2 text-right">{line.expectedQuantity}</td>
                        <td className="p-2 text-right">{line.countedQuantity ?? "—"}</td>
                        <td className="p-2 text-right">{line.varianceQuantity ?? "—"}</td>
                        <td className="p-2 text-right">{line.movementDuringCount ?? "—"}</td>
                        <td className="p-2 text-right">{line.movementDelta ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <RetailStockCountCardSection
            exportStockCountCsv={exportStockCountCsv}
            exportingCsv={exportingCsv}
            report={report}
            setSelectedId={setSelectedId}
          />
        </div>
      </div>

      {finalizeOpen && session && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog">
          <div className="w-full max-w-md space-y-3 rounded-xl border bg-background p-4 shadow-lg">
            <h2 className="text-lg font-semibold">Finalize {session.code}</h2>
            <p className="text-sm text-muted-foreground">
              {session.countedLineCount}/{session.lineCount} lines counted · variance {session.varianceQuantityTotal}{" "}
              units. Finalization writes one stock movement per counted line and cannot be repeated.
            </p>
            {session.uncountedLineCount > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowUncounted}
                  onChange={(event) => setAllowUncounted(event.target.checked)}
                  data-testid="stock-count-allow-uncounted"
                />
                Leave {session.uncountedLineCount} uncounted lines untouched
              </label>
            )}
            {session.varianceLineCount > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmVariance}
                  onChange={(event) => setConfirmVariance(event.target.checked)}
                  data-testid="stock-count-confirm-variance"
                />
                I confirm the {session.varianceLineCount} variance lines are correct
              </label>
            )}
            <div>
              <Label htmlFor="stock-count-finalize-notes">Notes (optional)</Label>
              <Input
                id="stock-count-finalize-notes"
                value={finalizeNotes}
                onChange={(event) => setFinalizeNotes(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFinalizeOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={finalizeMutation.isPending}
                onClick={() => finalizeMutation.mutate()}
                data-testid="stock-count-finalize"
              >
                {finalizeMutation.isPending ? "Finalizing…" : "Finalize count"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
