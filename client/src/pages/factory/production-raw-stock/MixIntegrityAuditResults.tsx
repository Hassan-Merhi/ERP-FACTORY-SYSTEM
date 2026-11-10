import { Button } from "@/components/ui/button";
import { formatNumber } from "@/lib/formatNumber";
import { Loader2, ShieldCheck } from "lucide-react";
import type { MixIntegrityAudits } from "./useMixIntegrityAudits";

/** Monitor status and on-screen results of the read-only mix integrity audits. */
export function MixIntegrityAuditResults({ audits }: { audits: MixIntegrityAudits }) {
  const {
    canAuditHistoricalMixes,
    historicalAudit,
    phase4Audit,
    phase5Audit,
    phase6Audit,
    phase7Monitor,
    monitorRefreshError,
    isRefreshingMonitor,
    handleRefreshMonitor,
  } = audits;
  return (
    <>
      {canAuditHistoricalMixes && (
        <div
          className="mb-4 space-y-3 rounded-xl border border-border/70 bg-muted/20 p-4"
          data-testid="mix-phase7-monitor-status"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Phase 7 · Automatic Mix Integrity Monitoring</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleRefreshMonitor}
              disabled={isRefreshingMonitor}
              data-testid="button-refresh-mix-integrity-status"
            >
              {isRefreshingMonitor ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="mr-2 h-4 w-4" />
              )}
              Refresh Status
            </Button>
          </div>
          {monitorRefreshError && <p className="text-xs text-destructive">{monitorRefreshError}</p>}
          {!phase7Monitor ? (
            <p className="text-xs text-muted-foreground">Checking the last completed scheduled scan…</p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                {phase7Monitor.monitoringEnabled
                  ? "Daily 01:35 UTC (server scheduler enabled)"
                  : "Automatic checking disabled in server settings"}
                .{" "}
                {phase7Monitor.initialized
                  ? "Last successful check: " + new Date(phase7Monitor.lastSuccessAt!).toLocaleString()
                  : "Awaiting the first successful scan to establish a historical baseline."}
              </p>
              {phase7Monitor.stale && (
                <p role="alert" className="text-xs font-semibold text-destructive">
                  Last successful scan is over 48 hours old. Monitoring findings may be outdated; review Factory Alerts
                  and server logs.
                </p>
              )}
              {phase7Monitor.summary && (
                <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                  <div>
                    <p className="text-xs text-muted-foreground">Critical findings</p>
                    <p className="font-mono font-bold">{phase7Monitor.summary.critical}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Warnings</p>
                    <p className="font-mono font-bold">{phase7Monitor.summary.warning}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Evidence reviews</p>
                    <p className="font-mono font-bold">{phase7Monitor.summary.review}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Unread monitor alerts</p>
                    <p className="font-mono font-bold">{phase7Monitor.unreadAlerts}</p>
                  </div>
                </div>
              )}
              <p className="text-xs text-muted-foreground">
                Historical defects remain visible in the detailed audits. New or worsened findings appear in Factory
                Alerts; ordinary later supplier-rate changes do not count as saved-batch cost errors. No automatic
                revaluation, historical write-off or accounting posting.
              </p>
            </>
          )}
        </div>
      )}
      {phase6Audit && (
        <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-phase6-audit-results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Phase 6 · Completed Mix and Carry-Forward Audit</p>
            <span className="text-xs text-muted-foreground">Read-only · {phase6Audit.generatedAt.slice(0, 10)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Completed with remaining kg</p>
              <p className="font-mono font-bold">{phase6Audit.summary.completedWithRemainderBatches}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Total remaining kg</p>
              <p className="font-mono font-bold">{formatNumber(Number(phase6Audit.summary.completedRemainderKg), 3)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Over-consumed batches</p>
              <p className="font-mono font-bold">{phase6Audit.summary.overusedBatches}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Carry-forward integrity flags</p>
              <p className="font-mono font-bold">{phase6Audit.summary.carryForwardExceptions}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Existing completed discrepancies are protected. Remaining kilograms are not automatically treated as
            physical stock or discarded waste. Verify original production and adjustments first. The CSV contains every
            exception and its recorded used/total kilograms.
          </p>
          {phase6Audit.batches.filter(
            (row) => !row.deleted && row.issues.some((issue) => issue.severity !== "informational")
          ).length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="font-semibold">First 12 historical quantity exceptions</p>
              {phase6Audit.batches
                .filter((row) => !row.deleted && row.issues.some((issue) => issue.severity !== "informational"))
                .slice(0, 12)
                .map((row) => (
                  <p key={row.batchId} className="font-mono text-muted-foreground">
                    <span className="text-foreground">{row.batchCode}</span>
                    {" · "}total {formatNumber(Number(row.totalKg), 3)} kg
                    {" · "}used {formatNumber(Number(row.usedKg), 3)} kg
                    {" · "}
                    {row.issues.map((issue) => issue.code).join(", ")}
                  </p>
                ))}
            </div>
          )}
        </div>
      )}
      {phase5Audit && (
        <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-phase5-audit-results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Phase 5 · Production, Bale & GL Reconciliation</p>
            <span className="text-xs text-muted-foreground">Read-only · {phase5Audit.generatedAt.slice(0, 10)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Consumed mixes without output links</p>
              <p className="font-mono font-bold">{phase5Audit.summary.consumedMixesWithoutLineage}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Bales without mix link</p>
              <p className="font-mono font-bold">{formatNumber(phase5Audit.summary.unlinkedBaleRows, 0)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Bales marked sold</p>
              <p className="font-mono font-bold">{formatNumber(phase5Audit.summary.soldBales, 0)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Historical recost runs</p>
              <p className="font-mono font-bold">{phase5Audit.summary.historicalBaleRecostRuns}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Direct mix links: {phase5Audit.summary.balesLinkedDirectlyToMix}; through pressing:{" "}
            {phase5Audit.summary.balesLinkedViaPressing}. No linked mismatch means no comparable evidence, not proof
            that unlinked bale costs are accurate.
            {phase5Audit.summary.inventoryCutoverActive
              ? " A perpetual-inventory cutover is active; atomic GL journal approval is required."
              : " No active perpetual-inventory cutover was found in this snapshot."}
          </p>
          {phase5Audit.summary.consumedMixesWithoutLineage > 0 && (
            <div className="space-y-1 text-xs">
              <p className="font-semibold">Historical recost blocked pending production evidence</p>
              {phase5Audit.batches
                .filter((batch) => batch.classification === "NO_RECORDED_PRODUCTION_LINEAGE")
                .slice(0, 10)
                .map((batch) => (
                  <p key={batch.batchId} className="font-mono text-muted-foreground">
                    {batch.batchCode} · {formatNumber(Number(batch.usedKg), 3)} kg used · no linked output
                  </p>
                ))}
              <p className="text-muted-foreground">
                Export Bale/GL CSV for the full batch list and exception classification.
              </p>
            </div>
          )}
        </div>
      )}
      {phase4Audit && (
        <div className="mb-4 space-y-3 rounded-xl border border-border/70 p-4" data-testid="mix-phase4-audit-results">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Phase 4 · Raw Material & Ownership Reconciliation</p>
            <span className="text-xs text-muted-foreground">Read-only · {phase4Audit.generatedAt.slice(0, 10)}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Receipt-row overdraws</p>
              <p className="font-mono font-bold">{phase4Audit.summary.rawStockOverdrawRows}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Overdrawn kg</p>
              <p className="font-mono font-bold">{formatNumber(Number(phase4Audit.summary.totalRawRowOverdrawKg))}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source ownership reviews</p>
              <p className="font-mono font-bold">{phase4Audit.summary.ownershipSourceExceptions}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Unclassified valued ADDs</p>
              <p className="font-mono font-bold">{phase4Audit.summary.unclassifiedValuedAdds}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Receipt-row negative balances can be covered by recorded supplier ADD adjustments. Historical ownership and
            currency corrections require original supporting evidence; no automatic changes are made.
          </p>
          {phase4Audit.rawStockExceptions.map((stock) => (
            <p className="text-xs text-muted-foreground" key={stock.rawStockId}>
              <span className="font-mono text-foreground">
                {stock.containerNumber ?? `Raw stock #${stock.rawStockId}`}
              </span>
              {" · "}Excess {formatNumber(Number(stock.excessUsedKg))} kg
              {" · "}
              {stock.supplierCoverage === "POTENTIALLY_ADJUSTMENT_BACKED"
                ? "Potentially ADD-backed"
                : "Supplier shortage review"}
            </p>
          ))}
          <p className="text-xs text-muted-foreground">
            {phase4Audit.summary.ownershipAffectedBatches} batches have ownership references to verify;
            {phase4Audit.summary.unclassifiedNonUsdAdds > 0
              ? ` ${phase4Audit.summary.unclassifiedNonUsdAdds} valued ADD requires non-USD FX evidence.`
              : ""}{" "}
            Export the three CSV files for the full exception records.
          </p>
        </div>
      )}
      {historicalAudit && (
        <div
          className="mb-4 space-y-3 rounded-xl border border-border/70 p-4"
          data-testid="mix-historical-audit-results"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">Historical Reconciliation Snapshot</p>
            <span className="text-xs text-muted-foreground">
              {historicalAudit.summary.activeBatches} active · {historicalAudit.summary.deletedBatches} deleted ·{" "}
              {historicalAudit.summary.sources} saved sources
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Header discrepancies</p>
              <p className="font-mono font-bold">{historicalAudit.summary.headerMismatchBatches}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Cost arithmetic flags</p>
              <p className="font-mono font-bold">{historicalAudit.summary.sourceLineMismatchBatches}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Source evidence review</p>
              <p className="font-mono font-bold">{historicalAudit.summary.evidenceReviewBatches}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Current-rate differences</p>
              <p className="font-mono font-bold">{historicalAudit.summary.currentRateEstimateDifferenceBatches}</p>
            </div>
          </div>
          <p className="text-xs text-muted-foreground">
            Current supplier rates can change after offload. Differences from recorded historical rates are
            informational, not permission to overwrite a batch. Export the source CSV to investigate individual records.
          </p>
          {historicalAudit.batches.filter(
            (b) => !b.deleted && (b.classification === "ARITHMETIC_ERROR" || b.classification === "EVIDENCE_REVIEW")
          ).length > 0 && (
            <div className="space-y-1 text-xs">
              <p className="font-semibold">Batches requiring evidence or mathematical correction review</p>
              {historicalAudit.batches
                .filter(
                  (b) =>
                    !b.deleted && (b.classification === "ARITHMETIC_ERROR" || b.classification === "EVIDENCE_REVIEW")
                )
                .slice(0, 12)
                .map((b) => (
                  <p key={b.batchId} className="text-muted-foreground">
                    <span className="font-mono text-foreground">{b.batchCode}</span>
                    {" · "}
                    {[
                      ...new Set(
                        b.issues.filter((issue) => issue.severity !== "informational").map((issue) => issue.code)
                      ),
                    ].join(", ")}
                  </p>
                ))}
              <p className="text-muted-foreground">
                All flagged records, including deleted batches, are available in the CSV exports.
              </p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
