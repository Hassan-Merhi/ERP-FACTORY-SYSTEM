import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";

import { Button } from "@/components/ui/button";
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
import { useRawStockRecalculate } from "../useRawStockRecalculate";
import { useRawStockReplayPanelModel } from "./RawStockReplayPanelModel";
import { RawStockReplayTab } from "./RawStockReplayTab";

export interface RawStockReplayPanelProps {
  rawStock: ReturnType<typeof useRawStockRecalculate>;
}

export function RawStockReplayPanel({ rawStock }: RawStockReplayPanelProps) {
  const m = useRawStockReplayPanelModel({ rawStock });

  return (
    <>
      {/* ── Tab: Historical Cost Replay ─────────────────────────────────── */}
      <RawStockReplayTab m={m} />

      {/* ── Historical Replay Confirmation Dialog ─────────────────────────── */}
      {/* Requires the admin to type exactly "APPLY HISTORICAL REPLAY" before the
          mutation fires — prevents accidental one-click financial corrections. */}
      <Dialog
        open={m.showReplayConfirmDialog}
        onOpenChange={(open) => {
          if (!open) {
            m.setShowReplayConfirmDialog(false);
            m.setReplayConfirmText("");
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
              {m.preparedReplayToken?.scope ? (
                <span className="block">
                  This will update <strong>{m.preparedReplayToken.scope.suppliers}</strong> supplier(s),{" "}
                  <strong>{m.preparedReplayToken.scope.containers}</strong> container(s),{" "}
                  <strong>{m.preparedReplayToken.scope.supplierSources}</strong> source row(s),{" "}
                  <strong>{m.preparedReplayToken.scope.batches}</strong> batch(es), and{" "}
                  <strong>{m.preparedReplayToken.scope.availableBales}</strong> bale(s)
                  {m.preparedReplayToken.scope.finalizedBales > 0 && (
                    <span> (including {m.preparedReplayToken.scope.finalizedBales} finalized bale(s))</span>
                  )}
                  {m.preparedReplayToken.scope.blockedBatches > 0 && (
                    <span className="text-amber-600">
                      {" "}
                      — {m.preparedReplayToken.scope.blockedBatches} batch(es) blocked from correction
                    </span>
                  )}
                  .
                  <br />
                  This operation <strong>corrects historical cost data</strong> and cannot be trivially reversed — an
                  undo snapshot will be saved.
                </span>
              ) : m.replayPreview ? (
                <span className="block">
                  This will apply the historical cost replay for{" "}
                  <strong>{m.preparedReplayToken?.safeSupplierIds?.length ?? 0}</strong> supplier(s).
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
                value={m.replayConfirmText}
                onChange={(e) => m.setReplayConfirmText(e.target.value)}
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
                m.setShowReplayConfirmDialog(false);
                m.setReplayConfirmText("");
              }}
            >
              Cancel
            </Button>
            {/* FIX 12: Apply uses the stored token from the Prepare step — no second dry-run. */}
            <Button
              size="sm"
              disabled={
                !isHistoricalReplayConfirmed(m.replayConfirmText) ||
                m.replayApplyMutation.isPending ||
                !m.preparedReplayToken?.confirmationToken
              }
              onClick={() => {
                if (!m.preparedReplayToken?.confirmationToken) return;
                m.replayApplyMutation.mutate(
                  {
                    // DEFECT 3 FIX: Use the supplier IDs stored in the prepared token,
                    // not the current UI selection state. The token was signed with
                    // safeSupplierIds — sending a different set would fail the server's
                    // supplier guard and could expand scope beyond what was reviewed.
                    supplierIds: m.preparedReplayToken.safeSupplierIds,
                    includeCompletedBatches: m.includeCompletedBatches,
                    includeFinalizedBales: m.includeFinalizedBales,
                    confirmationToken: m.preparedReplayToken.confirmationToken,
                  },
                  {
                    onSettled: () => {
                      m.setShowReplayConfirmDialog(false);
                      m.setReplayConfirmText("");
                      m.setPreparedReplayToken(null);
                    },
                  }
                );
              }}
              className="gap-2 bg-emerald-600 hover:bg-emerald-700 text-white"
            >
              <CheckCircle2 className="h-3.5 w-3.5" />
              {m.replayApplyMutation.isPending ? "Applying…" : "Apply Historical Replay"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Recompute Supplier Rates — dry-run preview & confirmation dialog ── */}
      <Dialog
        open={m.showRecomputeDialog}
        onOpenChange={(open) => {
          if (!open) {
            m.setShowRecomputeDialog(false);
            m.setRecomputePreviewRows(null);
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

          {m.recomputePreviewRows && (
            <div className="space-y-3 mt-2">
              {/* Suppliers that would change */}
              {m.recomputePreviewRows.filter((r) => !r.skipped).length > 0 && (
                <div className="border rounded-md overflow-hidden">
                  <div className="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
                    Would update ({m.recomputePreviewRows.filter((r) => !r.skipped).length} suppliers)
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
                      {m.recomputePreviewRows
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
              {m.recomputePreviewRows.filter((r) => !!r.skipped).length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {m.recomputePreviewRows.filter((r) => !!r.skipped).length} supplier(s) skipped (already correct or no
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
                    m.setShowRecomputeDialog(false);
                    m.setRecomputePreviewRows(null);
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
