// Extracted from ./RawStockOperationsPanel.tsx to keep that module under the source-size cap.
import { CheckCircle2, ChevronDown, ChevronRight, Layers } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";
import { badgePct, statusBadge } from "./presentation";
import { getRawStockErrorMessage } from "../useRawStockRecalculate";
import { useRawStockOperationsPanelState } from "./useRawStockOperationsPanelState";

export function RawStockOperationsPanelSection({
  affectedBatches,
  allSelected,
  applyMutation,
  batchesLoading,
  expandedBatchSources,
  fxUnresolvedRows,
  handleApply,
  handleFixPartialOffloads,
  hiddenHistoricalCount,
  includeCompletedBatches,
  isLoading,
  isPreviewError,
  partialOffloadCandidates,
  previewErrorMsg,
  refetch,
  rows,
  selected,
  selectedIds,
  setDetailBatchId,
  toggleAll,
  toggleBatchSourcesExpanded,
  toggleOne,
  unchangedCount,
  visibleChangedRows,
}: Pick<
  ReturnType<typeof useRawStockOperationsPanelState>,
  | "affectedBatches"
  | "allSelected"
  | "applyMutation"
  | "batchesLoading"
  | "expandedBatchSources"
  | "fxUnresolvedRows"
  | "handleApply"
  | "handleFixPartialOffloads"
  | "hiddenHistoricalCount"
  | "includeCompletedBatches"
  | "isLoading"
  | "isPreviewError"
  | "partialOffloadCandidates"
  | "previewErrorMsg"
  | "refetch"
  | "rows"
  | "selected"
  | "selectedIds"
  | "setDetailBatchId"
  | "toggleAll"
  | "toggleBatchSourcesExpanded"
  | "toggleOne"
  | "unchangedCount"
  | "visibleChangedRows"
>) {
  return (
    <>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          {partialOffloadCandidates.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              disabled={applyMutation.isPending}
              onClick={handleFixPartialOffloads}
              title="Apply the correct fixed landed cost/kg to all PARTIALLY_RECEIVED containers with a changed cost and resolved FX rate — uses includeHistoricalContainers + includeCompletedBatches."
              className="gap-2 text-blue-700 border-blue-400/50 hover:bg-blue-500/10"
            >
              <Layers className="h-3.5 w-3.5" />
              {applyMutation.isPending
                ? "Applying..."
                : `Fix All Partial Offloads (${partialOffloadCandidates.length})`}
            </Button>
          )}
        </div>
        <Button
          size="sm"
          disabled={selected.size === 0 || applyMutation.isPending}
          onClick={handleApply}
          className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {applyMutation.isPending ? "Applying..." : `Apply Selected (${selected.size})`}
        </Button>
      </div>

      {isPreviewError ? (
        <div className="border border-red-500/30 bg-red-500/10 rounded-md p-3 text-sm text-red-700 dark:text-red-400 space-y-2">
          <div className="font-medium">Failed to load recalculation preview.</div>
          <div className="text-xs">
            {getRawStockErrorMessage(previewErrorMsg, "An unexpected error occurred. Check server logs.")}
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : isLoading ? (
        <div className="text-sm text-muted-foreground py-12 text-center">Computing recalculation preview...</div>
      ) : (
        <>
          {fxUnresolvedRows.length > 0 && (
            <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 text-xs text-amber-700 dark:text-amber-400 space-y-1">
              <div className="font-medium">
                {fxUnresolvedRows.length} container(s) have an unresolved/unconfirmed exchange rate and were skipped.
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                {fxUnresolvedRows.map((r) => (
                  <span key={r.containerId}>
                    {r.containerNumber} ({r.currencyCode})
                  </span>
                ))}
              </div>
              <div>Resolve/confirm these containers' exchange rates first, then refresh.</div>
            </div>
          )}

          {hiddenHistoricalCount > 0 && (
            <div className="text-xs text-muted-foreground bg-muted/40 border rounded-md px-3 py-2">
              {hiddenHistoricalCount} CLOSED/COMPLETED container(s) with mismatches are hidden — enable "Include
              CLOSED/COMPLETED containers" to see and repair them.
            </div>
          )}

          {visibleChangedRows.length === 0 && rows !== undefined ? (
            <div className="text-sm text-muted-foreground py-12 text-center border rounded-md bg-card">
              Nothing to fix — every container's cost/kg already matches its stored charges.
              {unchangedCount > 0 && ` (${unchangedCount} container(s) checked, all correct.)`}
            </div>
          ) : (
            <>
              <div className="text-xs text-muted-foreground">
                {visibleChangedRows.length} container(s) have a mismatch
                {unchangedCount > 0 ? ` — ${unchangedCount} other container(s) are already correct and hidden.` : "."}
              </div>
              <div className="border rounded-md overflow-hidden bg-card shadow-xs">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox checked={allSelected} onCheckedChange={toggleAll} data-testid="checkbox-select-all" />
                      </TableHead>
                      <TableHead>Container</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Supplier</TableHead>
                      <TableHead className="text-right">Received (kg)</TableHead>
                      <TableHead className="text-right">Remaining (kg)</TableHead>
                      <TableHead className="text-right">Current $/kg</TableHead>
                      <TableHead className="text-right">Corrected $/kg</TableHead>
                      <TableHead className="text-right">Change</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {visibleChangedRows.map((row) => (
                      <TableRow key={row.containerId} className="group">
                        <TableCell>
                          <Checkbox
                            checked={selected.has(row.containerId)}
                            onCheckedChange={() => toggleOne(row.containerId)}
                            data-testid={`checkbox-row-${row.containerId}`}
                          />
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.containerNumber}</TableCell>
                        <TableCell>{statusBadge(row.containerStatus)}</TableCell>
                        <TableCell className="text-sm">{row.supplierName}</TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {formatNumber(row.receivedKg)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {row.fullyUsed ? (
                            <span className="text-amber-600">fully used</span>
                          ) : (
                            formatNumber(row.remainingKg)
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          ${(row.old?.costPerKgUsd ?? 0).toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium text-foreground">
                          ${(row.next?.costPerKgUsd ?? 0).toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right">{badgePct(row.diffPct)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}

          {selectedIds.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Layers className="h-3.5 w-3.5" />
                Mix batches that would be affected by the selected container(s)
                {batchesLoading && " — loading..."}
              </div>
              {!batchesLoading && (affectedBatches || []).length === 0 ? (
                <div className="text-xs text-muted-foreground py-6 text-center border rounded-md bg-card">
                  No mix batches are sourced from the selected container(s)
                  {!includeCompletedBatches ? " (that are still open)." : "."}
                </div>
              ) : (
                <div className="border rounded-md overflow-hidden bg-card shadow-xs">
                  <Table mobileLayout="cards">
                    <TableHeader className="bg-muted">
                      <TableRow>
                        <TableHead className="w-6" />
                        <TableHead>Batch</TableHead>
                        <TableHead>Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Total (kg)</TableHead>
                        <TableHead className="text-right">From Selected (kg)</TableHead>
                        <TableHead className="text-right">Old $/kg</TableHead>
                        <TableHead className="text-right">New $/kg</TableHead>
                        <TableHead className="text-right">Δ $/kg</TableHead>
                        <TableHead className="text-right">Total Δ</TableHead>
                        <TableHead className="text-right">Change</TableHead>
                        <TableHead className="text-right">Bales</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(affectedBatches || []).map((b) => (
                        <>
                          <TableRow
                            key={b.batchId}
                            className="cursor-pointer hover:bg-muted/40"
                            onClick={() => toggleBatchSourcesExpanded(b.batchId)}
                            data-testid={`row-affected-batch-${b.batchId}`}
                          >
                            <TableCell className="text-muted-foreground">
                              {expandedBatchSources.has(b.batchId) ? (
                                <ChevronDown className="h-3.5 w-3.5" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5" />
                              )}
                            </TableCell>
                            <TableCell
                              className="font-mono text-xs"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDetailBatchId(b.batchId);
                              }}
                            >
                              <span className="hover:underline cursor-pointer">{b.batchCode}</span>
                              {b.name ? <span className="text-muted-foreground"> — {b.name}</span> : null}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {b.batchDate ? new Date(b.batchDate).toLocaleDateString() : "—"}
                            </TableCell>
                            <TableCell>
                              <Badge
                                variant="outline"
                                className={
                                  b.wasCompleted
                                    ? "text-amber-600 border-amber-500/30 bg-amber-500/10"
                                    : "text-muted-foreground"
                                }
                              >
                                {b.status}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {formatNumber(b.totalWeightKg)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {formatNumber(b.weightKgFromSelectedContainers)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              ${(b.oldCostPerKg ?? 0).toFixed(6)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs font-medium">
                              ${(b.newCostPerKg ?? 0).toFixed(6)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {(b.costDifferencePerKg ?? 0) > 0 ? "+" : ""}${(b.costDifferencePerKg ?? 0).toFixed(6)}
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {(b.totalCostDifference ?? 0) > 0 ? "+" : ""}${(b.totalCostDifference ?? 0).toFixed(2)}
                            </TableCell>
                            <TableCell className="text-right">{badgePct(b.diffPct)}</TableCell>
                            <TableCell className="text-right font-mono text-xs text-muted-foreground">
                              {b.baleCount}
                            </TableCell>
                          </TableRow>
                          {expandedBatchSources.has(b.batchId) &&
                            (b.sourceChanges || []).map((sc) => (
                              <TableRow key={`${b.batchId}-${sc.containerId}`} className="bg-muted/20">
                                <TableCell />
                                <TableCell colSpan={2} className="font-mono text-[11px] text-muted-foreground pl-8">
                                  ↳ {sc.containerNumber}
                                </TableCell>
                                <TableCell />
                                <TableCell />
                                <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                                  {formatNumber(sc.weightKg)} kg
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px] text-muted-foreground">
                                  ${(sc.oldCostPerKgUsd ?? 0).toFixed(6)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-[11px]">
                                  ${(sc.newCostPerKgUsd ?? 0).toFixed(6)}
                                </TableCell>
                                <TableCell colSpan={4} />
                              </TableRow>
                            ))}
                        </>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Click a batch row to expand per-container sources · click the batch code to open its full detail.
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}
