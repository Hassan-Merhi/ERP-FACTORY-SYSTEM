import { Suspense } from "react";
import { Link } from "wouter";
import { ArrowLeft, History, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";

import { RawStockHistoryPanel } from "./rawstockrecalculate/RawStockHistoryPanel";
import { RawStockOperationsPanel } from "./rawstockrecalculate/RawStockOperationsPanel";
import { RawStockPartialFixPanel } from "./rawstockrecalculate/RawStockPartialFixPanel";
import { RawStockReplayPanel } from "./rawstockrecalculate/RawStockReplayPanel";
import { BatchDetail } from "./rawstockrecalculate/utils";
import { useRawStockRecalculate } from "./useRawStockRecalculate";

const tabs = [
  { id: "recalc" as const, label: "Container Cost Recalc" },
  { id: "sources" as const, label: "Source Cost Mismatches" },
  { id: "audit" as const, label: "Full Audit" },
  { id: "history" as const, label: "History & Rates" },
  { id: "replay" as const, label: "Historical Replay" },
  { id: "partialfix" as const, label: "Partial Offload Fix" },
];

export default function RawStockRecalculate() {
  const rawStock = useRawStockRecalculate();
  const {
    AdminDialog,
    includeCompletedBatches,
    setIncludeCompletedBatches,
    includeHistoricalContainers,
    setIncludeHistoricalContainers,
    detailBatchId,
    setDetailBatchId,
    activeTab,
    setActiveTab,
    refetch,
    sourceMismatches,
    refetchSources,
    fullAudit,
    refetchAudit,
    recomputeDryRunMutation,
    handleRecomputeSupplierRates,
    partialOffloadScan,
  } = rawStock;

  return (
    <div className="space-y-6 p-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link href="/factory/raw-stock">
            <Button variant="ghost" size="icon" className="h-9 w-9">
              <ArrowLeft className="h-4 w-4" />
            </Button>
          </Link>
          <div>
            <h1 className="text-lg font-bold leading-tight">Recalculate Raw Material Cost</h1>
            <p className="text-xs text-muted-foreground leading-tight">
              Recomputes each container's true landed cost/kg from its stored charges and shows what would change before
              anything is saved.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <Checkbox
              checked={includeCompletedBatches}
              onCheckedChange={(v) => setIncludeCompletedBatches(v === true)}
              data-testid="checkbox-include-completed-batches"
            />
            Also rewrite completed mix batches
          </label>
          <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none">
            <Checkbox
              checked={includeHistoricalContainers}
              onCheckedChange={(v) => setIncludeHistoricalContainers(v === true)}
              data-testid="checkbox-include-historical"
            />
            <History className="h-3 w-3" />
            Include CLOSED/COMPLETED containers
          </label>
          <Button
            variant="outline"
            size="sm"
            disabled={recomputeDryRunMutation.isPending}
            onClick={handleRecomputeSupplierRates}
            title="Recompute all supplier locked rates from receipt-weighted average of their corrected raw-stock rows. Use after a recalc run where all containers were fully used."
            className="gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Recompute Supplier Rates
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              refetch();
              refetchAudit();
              refetchSources();
            }}
            className="gap-2"
          >
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={`px-4 py-2 text-xs font-medium transition-colors border-b-2 -mb-px ${
              activeTab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
            {t.id === "sources" && (sourceMismatches?.length ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-red-500/15 text-red-600 text-[11px] px-1.5 py-0.5">
                {sourceMismatches!.length}
              </span>
            )}
            {t.id === "audit" && (fullAudit?.summary.safeRepairsAvailable ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/15 text-amber-600 text-[11px] px-1.5 py-0.5">
                {fullAudit!.summary.safeRepairsAvailable}
              </span>
            )}
            {t.id === "partialfix" && (partialOffloadScan?.affected.length ?? 0) > 0 && (
              <span className="ml-1.5 rounded-full bg-blue-500/15 text-blue-600 text-[11px] px-1.5 py-0.5">
                {partialOffloadScan!.affected.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {includeCompletedBatches && (
        <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          This will rewrite the cost of completed/closed mix batches (and any bales pressed from them) sourced from the
          selected containers — normally protected as locked historical record.
        </div>
      )}
      {includeHistoricalContainers && (
        <div className="text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-md px-3 py-2">
          CLOSED/COMPLETED containers will be included. Their supplier locked rate will NOT be changed (they have no
          remaining kg), but their raw-stock row and mix-batch sources will be corrected.
        </div>
      )}

      <RawStockOperationsPanel rawStock={rawStock} />
      <RawStockHistoryPanel rawStock={rawStock} />
      <RawStockReplayPanel rawStock={rawStock} />
      <RawStockPartialFixPanel rawStock={rawStock} />

      {/* Batch detail dialog */}
      <Dialog open={detailBatchId !== null} onOpenChange={(open) => !open && setDetailBatchId(null)}>
        <DialogContent className="max-w-4xl max-h-[85vh] overflow-y-auto">
          <DialogHeader className="sr-only">
            <DialogTitle>Mix Batch Detail</DialogTitle>
            <DialogDescription>Sources, bales, and cost breakdown for this mix batch.</DialogDescription>
          </DialogHeader>
          {detailBatchId !== null && (
            <Suspense fallback={<Skeleton className="h-64 w-full" />}>
              <BatchDetail batchId={detailBatchId} onBack={() => setDetailBatchId(null)} />
            </Suspense>
          )}
        </DialogContent>
      </Dialog>

      {AdminDialog}
    </div>
  );
}
