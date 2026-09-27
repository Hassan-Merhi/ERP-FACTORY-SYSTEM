import { CheckCircle2, ChevronDown, ChevronRight, Layers, RefreshCw, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";

import { badgePct, codeBadge, statusBadge } from "./presentation";
import { getRawStockErrorMessage, useRawStockRecalculate } from "../useRawStockRecalculate";

interface RawStockOperationsPanelProps {
  rawStock: ReturnType<typeof useRawStockRecalculate>;
}

export function RawStockOperationsPanel({ rawStock }: RawStockOperationsPanelProps) {
  const {
    selected,
    includeCompletedBatches,
    setDetailBatchId,
    selectedZeroCostSources,
    manualRates,
    setManualRates,
    expandedBatchSources,
    activeTab,
    rows,
    isLoading,
    isPreviewError,
    previewErrorMsg,
    refetch,
    fxUnresolvedRows,
    unchangedCount,
    visibleChangedRows,
    hiddenHistoricalCount,
    allSelected,
    selectedIds,
    affectedBatches,
    batchesLoading,
    sourceMismatches,
    sourceMismatchLoading,
    fixableSourceMismatches,
    manualSourceMismatches,
    allSourceMismatchSelected,
    fullAudit,
    auditLoading,
    autoApplyFxMutation,
    toggleAll,
    toggleOne,
    toggleSourceMismatch,
    toggleAllSourceMismatches,
    toggleBatchSourcesExpanded,
    applyMutation,
    handleApply,
    applyAllSafeMutation,
    handleApplyAllSafe,
    partialOffloadCandidates,
    handleFixPartialOffloads,
    fixAllSourcesMutation,
    handleFixAllSources,
    sourceMismatchFixMutation,
    handleFixSourceMismatches,
  } = rawStock;

  return (
    <>
      {/* ── Tab: Container Cost Recalc ─────────────────────────────────────── */}
      {activeTab === "recalc" && (
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
                    {fxUnresolvedRows.length} container(s) have an unresolved/unconfirmed exchange rate and were
                    skipped.
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
                    {unchangedCount > 0
                      ? ` — ${unchangedCount} other container(s) are already correct and hidden.`
                      : "."}
                  </div>
                  <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                    <Table mobileLayout="cards">
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          <TableHead className="w-10">
                            <Checkbox
                              checked={allSelected}
                              onCheckedChange={toggleAll}
                              data-testid="checkbox-select-all"
                            />
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
                    <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                      <Table mobileLayout="cards">
                        <TableHeader className="bg-muted/50">
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
                                  {(b.costDifferencePerKg ?? 0) > 0 ? "+" : ""}$
                                  {(b.costDifferencePerKg ?? 0).toFixed(6)}
                                </TableCell>
                                <TableCell className="text-right font-mono text-xs">
                                  {(b.totalCostDifference ?? 0) > 0 ? "+" : ""}$
                                  {(b.totalCostDifference ?? 0).toFixed(2)}
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
                                    <TableCell colSpan={2} className="font-mono text-[10px] text-muted-foreground pl-8">
                                      ↳ {sc.containerNumber}
                                    </TableCell>
                                    <TableCell />
                                    <TableCell />
                                    <TableCell className="text-right font-mono text-[10px] text-muted-foreground">
                                      {formatNumber(sc.weightKg)} kg
                                    </TableCell>
                                    <TableCell className="text-right font-mono text-[10px] text-muted-foreground">
                                      ${(sc.oldCostPerKgUsd ?? 0).toFixed(6)}
                                    </TableCell>
                                    <TableCell className="text-right font-mono text-[10px]">
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
      )}

      {/* ── Tab: Source Cost Mismatches ────────────────────────────────────── */}
      {activeTab === "sources" && (
        <div className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold leading-tight">Mix-batch source cost mismatches</h2>
            <p className="text-xs text-muted-foreground leading-tight">
              Sources whose recorded cost/kg doesn't match the container's corrected USD cost — includes both zero-cost
              and nonzero-but-wrong values.
            </p>
          </div>
          {sourceMismatchLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (sourceMismatches || []).length === 0 ? (
            <div className="text-xs text-muted-foreground py-6 text-center border rounded-md bg-card">
              No source cost mismatches found.
            </div>
          ) : (
            <>
              <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="w-10">
                        <Checkbox
                          checked={allSourceMismatchSelected}
                          onCheckedChange={toggleAllSourceMismatches}
                          disabled={fixableSourceMismatches.length === 0}
                        />
                      </TableHead>
                      <TableHead>Batch</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right">Current $/kg (USD)</TableHead>
                      <TableHead className="text-right">Corrected $/kg (USD)</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(sourceMismatches || []).map((r) => (
                      <TableRow key={r.sourceId}>
                        <TableCell>
                          <Checkbox
                            checked={selectedZeroCostSources.has(r.sourceId)}
                            onCheckedChange={() => toggleSourceMismatch(r.sourceId)}
                            disabled={!r.fixable && r.containerId != null}
                          />
                        </TableCell>
                        <TableCell
                          className="font-mono text-xs cursor-pointer hover:underline"
                          onClick={() => setDetailBatchId(r.batchId)}
                        >
                          {r.batchCode}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {r.containerNumber
                            ? `Container ${r.containerNumber}`
                            : r.supplierName
                              ? `Supplier: ${r.supplierName}`
                              : "—"}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          {formatNumber(r.weightKg)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs text-muted-foreground">
                          ${(r.oldCostPerKgUsd ?? 0).toFixed(6)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-medium">
                          {r.fixable ? (
                            `${(r.newCostPerKgUsd ?? 0).toFixed(6)}`
                          ) : r.containerId == null ? (
                            <input
                              type="number"
                              step="0.000001"
                              placeholder="Enter $/kg USD"
                              className="w-28 text-right text-xs border rounded px-1.5 py-0.5 bg-background"
                              value={manualRates[r.sourceId] || ""}
                              onChange={(e) => setManualRates((prev) => ({ ...prev, [r.sourceId]: e.target.value }))}
                            />
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="text-xs" title={r.reason}>
                          {r.fixable ? (
                            <Badge
                              variant="outline"
                              className="text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
                            >
                              Ready
                            </Badge>
                          ) : r.containerId == null ? (
                            <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10">
                              Needs manual rate
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              Unresolved
                            </Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted-foreground">
                  {fixableSourceMismatches.length} fixable automatically · {manualSourceMismatches.length} need a manual
                  rate.
                </p>
                <div className="flex items-center gap-2">
                  {fixableSourceMismatches.length > 0 && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={sourceMismatchFixMutation.isPending}
                      onClick={handleFixAllSources}
                      title="Fix all fixable mismatches in one shot — no dry-run, admin-confirmed"
                    >
                      <RefreshCw className="h-4 w-4 mr-1.5" />
                      Fix All ({fixableSourceMismatches.length})
                    </Button>
                  )}
                  <Button
                    size="sm"
                    disabled={
                      selectedZeroCostSources.size === 0 ||
                      sourceMismatchFixMutation.isPending ||
                      fixAllSourcesMutation.isPending
                    }
                    onClick={handleFixSourceMismatches}
                  >
                    <CheckCircle2 className="h-4 w-4 mr-1.5" />
                    Fix Selected ({selectedZeroCostSources.size})
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      )}

      {/* ── Tab: Full Audit ────────────────────────────────────────────────── */}
      {activeTab === "audit" && (
        <div className="space-y-4">
          {auditLoading ? (
            <Skeleton className="h-48 w-full" />
          ) : !fullAudit ? (
            <div className="text-sm text-muted-foreground py-12 text-center">Loading audit...</div>
          ) : (
            <>
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Scanned", value: fullAudit.summary.totalContainersScanned, cls: "text-foreground" },
                  { label: "Correct", value: fullAudit.summary.containersCorrect, cls: "text-emerald-600" },
                  { label: "Safe repairs", value: fullAudit.summary.safeRepairsAvailable, cls: "text-red-600" },
                  { label: "Unresolved FX", value: fullAudit.summary.unresolvedFxContainers, cls: "text-amber-600" },
                  {
                    label: "Container cost mismatch",
                    value: fullAudit.summary.containerCostMismatches,
                    cls: "text-red-600",
                  },
                  {
                    label: "Active RS mismatch",
                    value: fullAudit.summary.activeRawStockMismatches,
                    cls: "text-red-600",
                  },
                  { label: "Zero-cost sources", value: fullAudit.summary.zeroCostSources, cls: "text-red-600" },
                  {
                    label: "Nonzero source mismatch",
                    value: fullAudit.summary.nonZeroSourceCostMismatches,
                    cls: "text-red-600",
                  },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="border rounded-md p-3 bg-card text-center space-y-1">
                    <div className={`text-xl font-bold ${cls}`}>{value}</div>
                    <div className="text-[10px] text-muted-foreground leading-tight">{label}</div>
                  </div>
                ))}
              </div>

              {fullAudit.summary.safeRepairsAvailable > 0 && (
                <div className="flex items-center gap-3 border border-amber-500/30 bg-amber-500/10 rounded-md p-3">
                  <ShieldAlert className="h-4 w-4 text-amber-600 shrink-0" />
                  <p className="text-xs text-amber-700 dark:text-amber-400 flex-1">
                    {fullAudit.summary.safeRepairsAvailable} container(s) can be automatically repaired. Use "Apply All
                    Safe" to fix them all in one operation.
                  </p>
                  <Button
                    size="sm"
                    className="shrink-0 gap-1.5 bg-emerald-600 hover:bg-emerald-700 text-white"
                    disabled={applyAllSafeMutation.isPending}
                    onClick={handleApplyAllSafe}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    {applyAllSafeMutation.isPending ? "Applying..." : "Apply All Safe"}
                  </Button>
                </div>
              )}

              {/* Audit rows table */}
              <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead>Container</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Issue Codes</TableHead>
                      <TableHead className="text-right">Repairable?</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {fullAudit.rows
                      .filter((r) => !r.codes.includes("CORRECT") && !r.codes.includes("FULLY_USED"))
                      .map((r) => (
                        <TableRow key={r.containerId}>
                          <TableCell className="font-mono text-xs">{r.containerNumber}</TableCell>
                          <TableCell>{statusBadge(r.containerStatus)}</TableCell>
                          <TableCell>{r.codes.map(codeBadge)}</TableCell>
                          <TableCell className="text-right">
                            {r.safeToRepair ? (
                              <Badge
                                variant="outline"
                                className="text-emerald-500 border-emerald-500/30 bg-emerald-500/10"
                              >
                                Yes
                              </Badge>
                            ) : r.codes.includes("MANUAL_REVIEW_REQUIRED") ? (
                              <div className="flex items-center justify-end gap-2">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-6 text-xs px-2 text-blue-600 border-blue-500/30 bg-blue-500/10 hover:bg-blue-500/20"
                                  disabled={autoApplyFxMutation.isPending}
                                  onClick={() => autoApplyFxMutation.mutate([r.containerId])}
                                >
                                  Apply rate from FX table
                                </Button>
                                <Badge variant="outline" className="text-amber-600 border-amber-500/30 bg-amber-500/10">
                                  Manual review
                                </Badge>
                              </div>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      ))}
                  </TableBody>
                </Table>
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
