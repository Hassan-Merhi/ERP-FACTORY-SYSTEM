import { CheckCircle2, RefreshCw, ShieldAlert } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatNumber } from "@/lib/formatNumber";

import { codeBadge, statusBadge } from "./presentation";
import { useRawStockOperationsPanelState, type RawStockOperationsPanelProps } from "./useRawStockOperationsPanelState";
import { RawStockOperationsPanelSection } from "./RawStockOperationsPanelSection";

export function RawStockOperationsPanel(props: RawStockOperationsPanelProps) {
  const {
    activeTab,
    affectedBatches,
    allSelected,
    allSourceMismatchSelected,
    applyAllSafeMutation,
    applyMutation,
    auditLoading,
    autoApplyFxMutation,
    batchesLoading,
    expandedBatchSources,
    fixAllSourcesMutation,
    fixableSourceMismatches,
    fullAudit,
    fxUnresolvedRows,
    handleApply,
    handleApplyAllSafe,
    handleFixAllSources,
    handleFixPartialOffloads,
    handleFixSourceMismatches,
    hiddenHistoricalCount,
    includeCompletedBatches,
    isLoading,
    isPreviewError,
    manualRates,
    manualSourceMismatches,
    partialOffloadCandidates,
    previewErrorMsg,
    refetch,
    rows,
    selected,
    selectedIds,
    selectedZeroCostSources,
    setDetailBatchId,
    setManualRates,
    sourceMismatchFixMutation,
    sourceMismatchLoading,
    sourceMismatches,
    toggleAll,
    toggleAllSourceMismatches,
    toggleBatchSourcesExpanded,
    toggleOne,
    toggleSourceMismatch,
    unchangedCount,
    visibleChangedRows,
  } = useRawStockOperationsPanelState(props);

  return (
    <>
      {/* ── Tab: Container Cost Recalc ─────────────────────────────────────── */}
      {activeTab === "recalc" && (
        <RawStockOperationsPanelSection
          affectedBatches={affectedBatches}
          allSelected={allSelected}
          applyMutation={applyMutation}
          batchesLoading={batchesLoading}
          expandedBatchSources={expandedBatchSources}
          fxUnresolvedRows={fxUnresolvedRows}
          handleApply={handleApply}
          handleFixPartialOffloads={handleFixPartialOffloads}
          hiddenHistoricalCount={hiddenHistoricalCount}
          includeCompletedBatches={includeCompletedBatches}
          isLoading={isLoading}
          isPreviewError={isPreviewError}
          partialOffloadCandidates={partialOffloadCandidates}
          previewErrorMsg={previewErrorMsg}
          refetch={refetch}
          rows={rows}
          selected={selected}
          selectedIds={selectedIds}
          setDetailBatchId={setDetailBatchId}
          toggleAll={toggleAll}
          toggleBatchSourcesExpanded={toggleBatchSourcesExpanded}
          toggleOne={toggleOne}
          unchangedCount={unchangedCount}
          visibleChangedRows={visibleChangedRows}
        />
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
              <div className="border rounded-md overflow-hidden bg-card shadow-xs">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted">
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
                              className="w-28 text-right text-xs border rounded-sm px-1.5 py-0.5 bg-background"
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
                    <div className="text-[11px] text-muted-foreground leading-tight">{label}</div>
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
              <div className="border rounded-md overflow-hidden bg-card shadow-xs">
                <Table mobileLayout="cards">
                  <TableHeader className="bg-muted">
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
