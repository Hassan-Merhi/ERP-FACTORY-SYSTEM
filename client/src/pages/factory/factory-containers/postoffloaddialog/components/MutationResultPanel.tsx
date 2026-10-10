/**
 * MutationResultPanel — extracted sub-component.
 *
 * Extracted from PostOffloadDialog.tsx during the Phase 4 god-file split.
 */
import { CheckCircle2 } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import type { MutationResult } from "../types";

export function MutationResultPanel({ result }: { result: MutationResult }) {
  const oldRate = result.supplierLockedRateBefore || result.supplierLockedRateOldExact;
  const newRate = result.supplierLockedRateAfter || result.supplierLockedRateNewExact;
  const supDelta = result.supplierInventoryValueDeltaUsd;
  const fraction =
    typeof result.remainingFraction === "number"
      ? result.remainingFraction
      : result.remainingFraction
        ? parseFloat(result.remainingFraction)
        : null;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-3 p-3 rounded-md bg-green-50 dark:bg-green-950/20 text-green-800 dark:text-green-300 text-sm">
        <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0" />
        <p className="font-semibold">{result.message}</p>
      </div>

      <div className="rounded-md border text-sm divide-y">
        <div className="grid grid-cols-3 gap-2 px-3 py-1.5 text-xs text-muted-foreground font-medium bg-muted/30">
          <span>Metric</span>
          <span className="text-right">Previous</span>
          <span className="text-right">New</span>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 py-2">
          <span className="text-muted-foreground">Container cost/kg (USD)</span>
          <span className="text-right font-mono">${result.oldContainerCostPerKgUsd.toFixed(6)}</span>
          <span className="text-right font-mono font-semibold text-green-700 dark:text-green-400">
            ${result.newContainerCostPerKgUsd.toFixed(6)}
          </span>
        </div>
        {oldRate && (
          <div className="grid grid-cols-3 gap-2 px-3 py-2">
            <span className="text-muted-foreground">Supplier locked rate</span>
            <span className="text-right font-mono">${parseFloat(oldRate).toFixed(8)}</span>
            <span className="text-right font-mono font-semibold">
              {newRate ? `$${parseFloat(newRate).toFixed(8)}` : "—"}
            </span>
          </div>
        )}
        {supDelta && result.supplierRemainingKg != null && (
          <div className="px-3 py-2 bg-muted/30 text-xs text-muted-foreground space-y-0.5">
            <div className="flex justify-between">
              <span>Supplier remaining</span>
              <span className="font-mono">{formatNumber(result.supplierRemainingKg)} kg</span>
            </div>
            <div className="flex justify-between">
              <span>Inventory value applied</span>
              <span className="font-mono">
                ${parseFloat(supDelta).toLocaleString("en", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            </div>
            {fraction != null && fraction < 0.9999 && result.fullContainerValueDeltaUsd && (
              <div className="mt-1 text-amber-700 dark:text-amber-400">
                Only {(fraction * 100).toFixed(0)}% of this container remains in inventory.
              </div>
            )}
          </div>
        )}
        <div className="grid grid-cols-3 gap-2 px-3 py-2 text-muted-foreground">
          <span>Raw-stock rows updated</span>
          <span className="text-right">—</span>
          <span className="text-right font-mono">{result.rawStockRowsUpdated ?? 0}</span>
        </div>
        <div className="grid grid-cols-3 gap-2 px-3 py-2 text-muted-foreground">
          <span>Bales updated</span>
          <span className="text-right">—</span>
          <span className="text-right font-mono">{result.affectedBalesCount}</span>
        </div>
      </div>

      {result.affectedBatches.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-semibold">Affected Mix Batches</p>
          <div className="border rounded-md divide-y text-sm">
            <div className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 px-3 py-1.5 text-xs text-muted-foreground font-medium bg-muted/30">
              <span>Batch</span>
              <span className="text-right">Old Cost/kg</span>
              <span className="text-right">New Cost/kg</span>
              <span className="text-right">Wt from container</span>
            </div>
            {result.affectedBatches.map((b) => (
              <div key={b.batchId} className="grid grid-cols-[2fr_1fr_1fr_1fr] gap-2 px-3 py-2 items-center">
                <span className="font-mono font-medium flex items-center gap-1.5 flex-wrap">
                  {b.batchCode}
                  {b.wasCompleted && (
                    <span className="text-xs bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 px-1.5 py-0.5 rounded-sm whitespace-nowrap">
                      Completed
                    </span>
                  )}
                </span>
                <span className="text-right font-mono text-muted-foreground">${b.oldCostPerKg.toFixed(4)}</span>
                <span className="text-right font-mono font-semibold">${b.newCostPerKg.toFixed(4)}</span>
                <span className="text-right font-mono text-muted-foreground">
                  {formatNumber(b.weightKgFromContainer)} kg
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────
