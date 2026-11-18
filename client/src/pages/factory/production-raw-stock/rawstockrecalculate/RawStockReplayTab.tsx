// Extracted from ./RawStockReplayPanel.tsx
import { RefreshCw, ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getRawStockErrorMessage } from "../useRawStockRecalculate";
import type { RawStockReplayPanelModel } from "./RawStockReplayPanelModel";

export function RawStockReplayTab({ m }: { m: RawStockReplayPanelModel }) {
  const { replayPreview } = m;
  const { selectedSupplierIds } = m;
  return (
    <>
      {m.activeTab === "replay" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs text-muted-foreground max-w-2xl">
              Replays container receipts, adjustments, and mix-batch consumption events in strict chronological order to
              compute the correct supplier moving-average rate at every point in time, then compares stored source costs
              against those historically-correct rates.
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={m.replayLoading}
              onClick={() => m.refetchReplay()}
              className="gap-2"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>

          {m.isReplayError && (
            <div className="border border-red-500/30 bg-red-500/10 rounded-md p-3 text-sm text-red-700 dark:text-red-400 space-y-2">
              <div className="font-medium">Failed to load historical replay preview.</div>
              <div className="text-xs">
                {getRawStockErrorMessage(m.replayErrorMsg, "An unexpected error occurred. Check server logs.")}
              </div>
              <Button size="sm" variant="outline" onClick={() => m.refetchReplay()}>
                Retry
              </Button>
            </div>
          )}

          {m.replayLoading && (
            <div className="text-sm text-muted-foreground py-12 text-center">
              Computing historical cost replay — this may take a moment…
            </div>
          )}

          {replayPreview && !m.replayLoading && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Containers scanned", value: replayPreview.summary.containersScanned },
                  { label: "Suppliers scanned", value: replayPreview.summary.suppliersScanned },
                  { label: "Safe to repair", value: replayPreview.summary.safeSuppliers, cls: "text-emerald-600" },
                  {
                    label: "Manual review",
                    value: replayPreview.summary.manualReviewSuppliers,
                    cls: "text-amber-600",
                  },
                  {
                    label: "Source mismatches",
                    value: replayPreview.summary.sourceMismatches,
                    cls: replayPreview.summary.sourceMismatches > 0 ? "text-red-500" : undefined,
                  },
                  { label: "Batches to update", value: replayPreview.summary.batchesToUpdate },
                  { label: "Bales to update", value: replayPreview.summary.balesToUpdate },
                  {
                    label: "Unresolved FX",
                    value: replayPreview.summary.unresolvedFx,
                    cls: replayPreview.summary.unresolvedFx > 0 ? "text-amber-600" : undefined,
                  },
                ].map(({ label, value, cls }) => (
                  <div key={label} className="border rounded-md px-3 py-2 bg-card">
                    <div className={`text-lg font-bold tabular-nums ${cls || ""}`}>{value}</div>
                    <div className="text-xs text-muted-foreground">{label}</div>
                  </div>
                ))}
              </div>

              {replayPreview.summary.scanCoverageError && (
                <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 text-xs text-amber-700 dark:text-amber-400">
                  <strong>Scan coverage mismatch:</strong> Some containers could not be included in the replay.
                  Containers scanned ({replayPreview.summary.containersScanned}) differs from universe (
                  {replayPreview.summary.totalReceivedContainers}). Check server logs for details.
                </div>
              )}

              {replayPreview.summary.missingDates > 0 && (
                <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 text-xs text-amber-700 dark:text-amber-400">
                  <strong>{replayPreview.summary.missingDates} event(s)</strong> have no effective date and were placed
                  at the end of the timeline. These suppliers are marked as requiring manual review and will be skipped
                  by the automated repair.
                </div>
              )}

              {replayPreview.summary.quantityTimelineMismatches > 0 && (
                <div className="border border-amber-500/30 bg-amber-500/10 rounded-md p-3 text-xs text-amber-700 dark:text-amber-400">
                  <strong>{replayPreview.summary.quantityTimelineMismatches} supplier(s)</strong> have a quantity
                  reconciliation mismatch — the event timeline's total kg doesn't match the raw stock remaining kg. This
                  usually means a batch consumed slightly more or fewer kg than what's recorded in the raw stock row.{" "}
                  Rows with <em>only</em> this issue can still be force-applied by checking them below.
                </div>
              )}

              {/* Supplier rows */}
              {replayPreview.supplierRows.length > 0 && (
                <div className="border rounded-md overflow-hidden bg-card shadow-xs">
                  <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-2">
                    Supplier Timelines
                    <Badge variant="outline" className="text-[11px]">
                      {replayPreview.supplierRows.length} supplier(s)
                    </Badge>
                  </div>
                  {/* FIX 11: Select All / Clear controls */}
                  {(() => {
                    const safeIds = replayPreview.supplierRows.filter((s) => s.safeToRepair).map((s) => s.supplierId);
                    const forceableIds = replayPreview.supplierRows
                      .filter(
                        (s) =>
                          !s.safeToRepair && s.reasons.length === 1 && s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH"
                      )
                      .map((s) => s.supplierId);
                    const totalSelectable = safeIds.length + forceableIds.length;
                    return totalSelectable > 0 ? (
                      <div className="flex items-center gap-2 px-3 py-1.5 border-b text-xs text-muted-foreground bg-muted/20">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            m.setSelectedSupplierIds(new Set([...safeIds, ...forceableIds]));
                            m.setPreparedReplayToken(null);
                          }}
                        >
                          Select All
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            m.setSelectedSupplierIds(new Set(safeIds));
                            m.setPreparedReplayToken(null);
                          }}
                        >
                          Safe Only
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            m.setSelectedSupplierIds(new Set());
                            m.setPreparedReplayToken(null);
                          }}
                        >
                          Clear
                        </Button>
                        <span className="ml-auto font-medium">
                          {selectedSupplierIds.size}/{totalSelectable} selected
                          {forceableIds.some((id) => selectedSupplierIds.has(id)) && (
                            <span className="ml-1 text-amber-600">(includes quantity-mismatch override)</span>
                          )}
                        </span>
                      </div>
                    ) : null;
                  })()}
                  <Table mobileLayout="cards">
                    <TableHeader>
                      <TableRow className="text-xs">
                        <TableHead className="w-8 pl-3"></TableHead>
                        <TableHead>Supplier</TableHead>
                        <TableHead className="text-right">Current rate</TableHead>
                        <TableHead className="text-right">Replay end rate</TableHead>
                        <TableHead className="text-right">Δ</TableHead>
                        <TableHead className="text-right">Sources</TableHead>
                        <TableHead className="text-right">Batches</TableHead>
                        <TableHead className="text-right">Bales</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {replayPreview.supplierRows.map((s) => {
                        const delta = s.endingExpectedRate - s.currentStoredRate;
                        const isChecked = selectedSupplierIds.has(s.supplierId);
                        // A quantity-mismatch-only row can be force-applied (user acknowledges the gap).
                        const isForceAppliable =
                          !s.safeToRepair && s.reasons.length === 1 && s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH";
                        const kgGap = Math.abs((s.replayRemainingKg ?? 0) - (s.authoritativeRemainingKg ?? 0));
                        return (
                          <TableRow
                            key={s.supplierId}
                            className={`text-xs ${isForceAppliable && isChecked ? "bg-amber-500/5" : ""}`}
                          >
                            {/* Checkbox: enabled for safe rows; also enabled (amber) for force-appliable rows */}
                            <TableCell className="pl-3">
                              <Checkbox
                                checked={isChecked}
                                disabled={!s.safeToRepair && !isForceAppliable}
                                className={
                                  isForceAppliable
                                    ? "border-amber-500 data-[state=checked]:bg-amber-500 data-[state=checked]:border-amber-500"
                                    : ""
                                }
                                onCheckedChange={(v) => {
                                  const next = new Set(selectedSupplierIds);
                                  if (v) next.add(s.supplierId);
                                  else next.delete(s.supplierId);
                                  m.setSelectedSupplierIds(next);
                                  // DEFECT 3 FIX: Changing supplier selection invalidates the
                                  // prepared token — user must re-Prepare after changing scope.
                                  m.setPreparedReplayToken(null);
                                }}
                              />
                            </TableCell>
                            <TableCell className="font-medium">{s.supplierName}</TableCell>
                            <TableCell className="text-right font-mono">${s.currentStoredRate.toFixed(6)}</TableCell>
                            <TableCell className="text-right font-mono">${s.endingExpectedRate.toFixed(6)}</TableCell>
                            <TableCell
                              className={`text-right font-mono ${Math.abs(delta) > 0.000001 ? (delta > 0 ? "text-red-500" : "text-emerald-500") : "text-muted-foreground"}`}
                            >
                              {delta > 0 ? "+" : ""}
                              {delta.toFixed(6)}
                            </TableCell>
                            <TableCell className="text-right">{s.affectedSourceCount}</TableCell>
                            <TableCell className="text-right">{s.affectedBatchCount}</TableCell>
                            <TableCell className="text-right">{s.affectedBaleCount}</TableCell>
                            <TableCell>
                              {s.safeToRepair ? (
                                <Badge
                                  variant="outline"
                                  className="text-emerald-600 border-emerald-500/30 bg-emerald-500/10 text-[11px]"
                                >
                                  Safe
                                </Badge>
                              ) : isForceAppliable ? (
                                <div className="flex flex-col gap-0.5">
                                  <Badge
                                    variant="outline"
                                    className="text-amber-600 border-amber-500/30 bg-amber-500/10 text-[11px]"
                                  >
                                    {s.reasons[0]}
                                  </Badge>
                                  <span className="text-[11px] text-muted-foreground">gap: {kgGap.toFixed(3)} kg</span>
                                </div>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-red-600 border-red-500/30 bg-red-500/10 text-[11px]"
                                >
                                  {s.reasons[0] || "Manual review"}
                                </Badge>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Options and apply — show when there are safe suppliers OR force-appliable ones */}
              {(replayPreview.summary.safeSuppliers > 0 ||
                replayPreview.supplierRows.some(
                  (s) => !s.safeToRepair && s.reasons.length === 1 && s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH"
                )) && (
                <div className="space-y-2 pt-2">
                  {/* includeFinalizedBales toggle */}
                  {(replayPreview.summary.finalizedBalesToUpdate ?? 0) > 0 && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground border rounded-md px-3 py-2 bg-amber-50 border-amber-200">
                      <Checkbox
                        id="include-finalized-bales"
                        checked={m.includeFinalizedBales}
                        onCheckedChange={(v) => m.setIncludeFinalizedBales(Boolean(v))}
                      />
                      <label htmlFor="include-finalized-bales" className="cursor-pointer font-medium text-amber-800">
                        Also update {replayPreview.summary.finalizedBalesToUpdate} finalized bale(s) (sold / dispatched
                        / invoiced)
                      </label>
                    </div>
                  )}
                  {/* FIX 12: "Prepare" fires the dry-run mutation only.
                      The confirm dialog is opened by the mutation's onSuccess handler
                      after the token is stored in state — ensuring every apply uses
                      a freshly-signed token that was reviewed before clicking Apply. */}
                  <div className="flex items-center justify-between gap-2">
                    {selectedSupplierIds.size === 0 && (
                      <span className="text-xs text-amber-600">
                        Select at least one supplier above to enable Prepare.
                      </span>
                    )}
                    {selectedSupplierIds.size > 0 &&
                      (() => {
                        const forceableSelected = replayPreview.supplierRows.filter(
                          (s) =>
                            !s.safeToRepair &&
                            s.reasons.length === 1 &&
                            s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH" &&
                            selectedSupplierIds.has(s.supplierId)
                        );
                        return forceableSelected.length > 0 ? (
                          <span className="text-xs text-amber-600">
                            ⚠ {forceableSelected.length} quantity-mismatch supplier(s) will be force-applied — rates are
                            computed from an incomplete timeline.
                          </span>
                        ) : null;
                      })()}
                    <div className="ml-auto">
                      <Button
                        size="sm"
                        disabled={
                          m.replayPrepareMutation.isPending ||
                          m.replayApplyMutation.isPending ||
                          selectedSupplierIds.size === 0
                        }
                        onClick={() => {
                          const allSelected = Array.from(selectedSupplierIds);
                          const safeSelected = allSelected.filter((id) =>
                            replayPreview.supplierRows.some((s) => s.supplierId === id && s.safeToRepair)
                          );
                          const forceSelected = allSelected.filter((id) =>
                            replayPreview.supplierRows.some(
                              (s) =>
                                s.supplierId === id &&
                                !s.safeToRepair &&
                                s.reasons.length === 1 &&
                                s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH"
                            )
                          );
                          m.wrapAdminAction(() => {
                            m.replayPrepareMutation.mutate({
                              supplierIds: safeSelected,
                              forceSupplierIds: forceSelected,
                              includeCompletedBatches: m.includeCompletedBatches,
                              includeFinalizedBales: m.includeFinalizedBales,
                            });
                          }, `Prepare historical cost replay for ${selectedSupplierIds.size} selected supplier(s) — a signed review token will be issued before any data is written.`);
                        }}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {m.replayPrepareMutation.isPending
                          ? "Preparing…"
                          : `Prepare Historical Replay (${selectedSupplierIds.size} supplier(s))`}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {replayPreview.summary.safeSuppliers === 0 &&
                !replayPreview.supplierRows.some(
                  (s) => !s.safeToRepair && s.reasons.length === 1 && s.reasons[0] === "TIMELINE_QUANTITY_MISMATCH"
                ) &&
                replayPreview.supplierRows.length > 0 && (
                  <div className="text-sm text-muted-foreground py-8 text-center border rounded-md bg-card">
                    No suppliers are safe to repair automatically.
                    {replayPreview.summary.manualReviewSuppliers > 0 &&
                      ` ${replayPreview.summary.manualReviewSuppliers} supplier(s) require manual review (missing event dates or quantity mismatches).`}
                  </div>
                )}

              {replayPreview.supplierRows.length === 0 && (
                <div className="text-sm text-muted-foreground py-12 text-center border rounded-md bg-card">
                  Nothing to fix — all supplier timelines are consistent with stored costs.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </>
  );
}
