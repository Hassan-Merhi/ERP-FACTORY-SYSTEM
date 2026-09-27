import { AlertTriangle, CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

import { HISTORICAL_REPLAY_CONFIRM_PHRASE, isHistoricalReplayConfirmed } from "./replayConfirmation";
import { getRawStockErrorMessage, useRawStockRecalculate } from "../useRawStockRecalculate";

interface RawStockReplayPanelProps {
  rawStock: ReturnType<typeof useRawStockRecalculate>;
}

export function RawStockReplayPanel({ rawStock }: RawStockReplayPanelProps) {
  const {
    wrapAdminAction,
    includeCompletedBatches,
    activeTab,
    showReplayConfirmDialog,
    setShowReplayConfirmDialog,
    replayConfirmText,
    setReplayConfirmText,
    includeFinalizedBales,
    setIncludeFinalizedBales,
    selectedSupplierIds,
    setSelectedSupplierIds,
    preparedReplayToken,
    setPreparedReplayToken,
    recomputePreviewRows,
    setRecomputePreviewRows,
    showRecomputeDialog,
    setShowRecomputeDialog,
    replayPreview,
    replayLoading,
    isReplayError,
    replayErrorMsg,
    refetchReplay,
    replayPrepareMutation,
    replayApplyMutation,
  } = rawStock;

  return (
    <>
      {/* ── Tab: Historical Cost Replay ─────────────────────────────────── */}
      {activeTab === "replay" && (
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
              disabled={replayLoading}
              onClick={() => refetchReplay()}
              className="gap-2"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh
            </Button>
          </div>

          {isReplayError && (
            <div className="border border-red-500/30 bg-red-500/10 rounded-md p-3 text-sm text-red-700 dark:text-red-400 space-y-2">
              <div className="font-medium">Failed to load historical replay preview.</div>
              <div className="text-xs">
                {getRawStockErrorMessage(replayErrorMsg, "An unexpected error occurred. Check server logs.")}
              </div>
              <Button size="sm" variant="outline" onClick={() => refetchReplay()}>
                Retry
              </Button>
            </div>
          )}

          {replayLoading && (
            <div className="text-sm text-muted-foreground py-12 text-center">
              Computing historical cost replay — this may take a moment…
            </div>
          )}

          {replayPreview && !replayLoading && (
            <div className="space-y-4">
              {/* Summary cards */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  { label: "Containers scanned", value: replayPreview.summary.containersScanned },
                  { label: "Suppliers scanned", value: replayPreview.summary.suppliersScanned },
                  { label: "Safe to repair", value: replayPreview.summary.safeSuppliers, cls: "text-emerald-600" },
                  { label: "Manual review", value: replayPreview.summary.manualReviewSuppliers, cls: "text-amber-600" },
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
                <div className="border rounded-md overflow-hidden bg-card shadow-sm">
                  <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground flex items-center gap-2">
                    Supplier Timelines
                    <Badge variant="outline" className="text-[10px]">
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
                            setSelectedSupplierIds(new Set([...safeIds, ...forceableIds]));
                            setPreparedReplayToken(null);
                          }}
                        >
                          Select All
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            setSelectedSupplierIds(new Set(safeIds));
                            setPreparedReplayToken(null);
                          }}
                        >
                          Safe Only
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 text-xs px-2"
                          onClick={() => {
                            setSelectedSupplierIds(new Set());
                            setPreparedReplayToken(null);
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
                                  setSelectedSupplierIds(next);
                                  // DEFECT 3 FIX: Changing supplier selection invalidates the
                                  // prepared token — user must re-Prepare after changing scope.
                                  setPreparedReplayToken(null);
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
                                  className="text-emerald-600 border-emerald-500/30 bg-emerald-500/10 text-[10px]"
                                >
                                  Safe
                                </Badge>
                              ) : isForceAppliable ? (
                                <div className="flex flex-col gap-0.5">
                                  <Badge
                                    variant="outline"
                                    className="text-amber-600 border-amber-500/30 bg-amber-500/10 text-[10px]"
                                  >
                                    {s.reasons[0]}
                                  </Badge>
                                  <span className="text-[10px] text-muted-foreground">gap: {kgGap.toFixed(3)} kg</span>
                                </div>
                              ) : (
                                <Badge
                                  variant="outline"
                                  className="text-red-600 border-red-500/30 bg-red-500/10 text-[10px]"
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
                        checked={includeFinalizedBales}
                        onCheckedChange={(v) => setIncludeFinalizedBales(Boolean(v))}
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
                          replayPrepareMutation.isPending ||
                          replayApplyMutation.isPending ||
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
                          wrapAdminAction(() => {
                            replayPrepareMutation.mutate({
                              supplierIds: safeSelected,
                              forceSupplierIds: forceSelected,
                              includeCompletedBatches,
                              includeFinalizedBales,
                            });
                          }, `Prepare historical cost replay for ${selectedSupplierIds.size} selected supplier(s) — a signed review token will be issued before any data is written.`);
                        }}
                        className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
                      >
                        <ShieldCheck className="h-3.5 w-3.5" />
                        {replayPrepareMutation.isPending
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

      {/* ── Historical Replay Confirmation Dialog ─────────────────────────── */}
      {/* Requires the admin to type exactly "APPLY HISTORICAL REPLAY" before the
          mutation fires — prevents accidental one-click financial corrections. */}
      <Dialog
        open={showReplayConfirmDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowReplayConfirmDialog(false);
            setReplayConfirmText("");
          }
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-emerald-600" />
              Confirm Historical Cost Replay
            </DialogTitle>
            <DialogDescription className="text-xs space-y-2 pt-1">
              {/* FIX 6: Read scope counts from preparedReplayToken.scope (exact write scope),
                  NOT from replayPreview.summary (which is global, not scoped to selection). */}
              {preparedReplayToken?.scope ? (
                <span className="block">
                  This will update <strong>{preparedReplayToken.scope.suppliers}</strong> supplier(s),{" "}
                  <strong>{preparedReplayToken.scope.containers}</strong> container(s),{" "}
                  <strong>{preparedReplayToken.scope.supplierSources}</strong> source row(s),{" "}
                  <strong>{preparedReplayToken.scope.batches}</strong> batch(es), and{" "}
                  <strong>{preparedReplayToken.scope.availableBales}</strong> bale(s)
                  {preparedReplayToken.scope.finalizedBales > 0 && (
                    <span> (including {preparedReplayToken.scope.finalizedBales} finalized bale(s))</span>
                  )}
                  {preparedReplayToken.scope.blockedBatches > 0 && (
                    <span className="text-amber-600">
                      {" "}
                      — {preparedReplayToken.scope.blockedBatches} batch(es) blocked from correction
                    </span>
                  )}
                  .
                  <br />
                  This operation <strong>corrects historical cost data</strong> and cannot be trivially reversed — an
                  undo snapshot will be saved.
                </span>
              ) : replayPreview ? (
                <span className="block">
                  This will apply the historical cost replay for{" "}
                  <strong>{preparedReplayToken?.safeSupplierIds?.length ?? 0}</strong> supplier(s).
                  <br />
                  This operation <strong>corrects historical cost data</strong> and cannot be trivially reversed — an
                  undo snapshot will be saved.
                </span>
              ) : null}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 pt-1">
            <div className="space-y-1.5">
              <Label htmlFor="replay-confirm-input" className="text-xs font-medium">
                Type <span className="font-mono font-bold text-destructive">{HISTORICAL_REPLAY_CONFIRM_PHRASE}</span> to
                confirm:
              </Label>
              <Input
                id="replay-confirm-input"
                value={replayConfirmText}
                onChange={(e) => setReplayConfirmText(e.target.value)}
                placeholder={HISTORICAL_REPLAY_CONFIRM_PHRASE}
                className="font-mono text-sm"
                autoComplete="off"
                autoFocus
              />
            </div>
          </div>

          <DialogFooter className="gap-2 pt-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setShowReplayConfirmDialog(false);
                setReplayConfirmText("");
              }}
            >
              Cancel
            </Button>
            {/* FIX 12: Apply uses the stored token from the Prepare step — no second dry-run. */}
            <Button
              size="sm"
              disabled={
                !isHistoricalReplayConfirmed(replayConfirmText) ||
                replayApplyMutation.isPending ||
                !preparedReplayToken?.confirmationToken
              }
              onClick={() => {
                if (!preparedReplayToken?.confirmationToken) return;
                replayApplyMutation.mutate(
                  {
                    // DEFECT 3 FIX: Use the supplier IDs stored in the prepared token,
                    // not the current UI selection state. The token was signed with
                    // safeSupplierIds — sending a different set would fail the server's
                    // supplier guard and could expand scope beyond what was reviewed.
                    supplierIds: preparedReplayToken.safeSupplierIds,
                    includeCompletedBatches,
                    includeFinalizedBales,
                    confirmationToken: preparedReplayToken.confirmationToken,
                  },
                  {
                    onSettled: () => {
                      setShowReplayConfirmDialog(false);
                      setReplayConfirmText("");
                      setPreparedReplayToken(null);
                    },
                  }
                );
              }}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {replayApplyMutation.isPending ? "Applying…" : "Apply Historical Replay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Recompute Supplier Rates — dry-run preview & confirmation dialog ── */}
      <Dialog
        open={showRecomputeDialog}
        onOpenChange={(open) => {
          if (!open) {
            setShowRecomputeDialog(false);
            setRecomputePreviewRows(null);
          }
        }}
      >
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              Confirm: Recompute Supplier Rates
            </DialogTitle>
            <DialogDescription className="text-xs">
              This will overwrite each supplier's locked rate with the{" "}
              <strong>all-time receipt-weighted average</strong> across all raw-stock rows. This differs from the{" "}
              <strong>moving-average formula</strong> used during real offloads, which weights by remaining kg at the
              moment of each offload.
              <br />
              <br />
              <span className="text-amber-700 dark:text-amber-400 font-medium">
                If you accidentally clicked this, close the dialog and use "History &amp; Rates → Restore from Audit
                Log" instead.
              </span>
            </DialogDescription>
          </DialogHeader>

          {recomputePreviewRows && (
            <div className="space-y-3 mt-2">
              {/* Suppliers that would change */}
              {recomputePreviewRows.filter((r) => !r.skipped).length > 0 && (
                <div className="border rounded-md overflow-hidden">
                  <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    Would update ({recomputePreviewRows.filter((r) => !r.skipped).length} suppliers)
                  </div>
                  <Table mobileLayout="cards">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Supplier</TableHead>
                        <TableHead className="text-right">Current rate</TableHead>
                        <TableHead className="text-right">→ New rate</TableHead>
                        <TableHead className="text-right">Δ</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recomputePreviewRows
                        .filter((r) => !r.skipped)
                        .map((r) => {
                          const delta = r.newRate - r.oldRate;
                          return (
                            <TableRow key={r.supplierId}>
                              <TableCell className="text-sm font-medium">{r.supplierName}</TableCell>
                              <TableCell className="text-right font-mono text-xs">${r.oldRate.toFixed(6)}</TableCell>
                              <TableCell className="text-right font-mono text-xs">${r.newRate.toFixed(6)}</TableCell>
                              <TableCell
                                className={`text-right font-mono text-xs ${delta > 0 ? "text-red-500" : "text-emerald-500"}`}
                              >
                                {delta > 0 ? "+" : ""}
                                {delta.toFixed(6)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                    </TableBody>
                  </Table>
                </div>
              )}

              {/* Skipped suppliers */}
              {recomputePreviewRows.filter((r) => !!r.skipped).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {recomputePreviewRows.filter((r) => !!r.skipped).length} supplier(s) skipped (already correct or no
                  data).
                </p>
              )}

              {/* DEFECT 13 FIX: Apply button removed — deprecated, use Historical Replay. */}
              <div className="flex justify-end gap-2 pt-2">
                <p className="text-xs text-amber-700 dark:text-amber-400 mr-auto mt-1 font-medium">
                  Applying is deprecated — use <strong>Historical Cost Replay</strong> instead.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowRecomputeDialog(false);
                    setRecomputePreviewRows(null);
                  }}
                >
                  Close
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
