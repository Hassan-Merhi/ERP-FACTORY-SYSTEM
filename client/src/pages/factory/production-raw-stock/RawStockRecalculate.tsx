import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Suspense } from "react";
import { History, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

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
      <PageHeader
        title="Recalculate Raw Material Cost"
        backTarget="/factory/raw-stock"
        subtitle={
          <>
            Recomputes each container's true landed cost/kg from its stored charges and shows what would change before
            anything is saved.
          </>
        }
      >
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
      </PageHeader>

      {/* Tabs */}
      <TabsList className="w-max max-w-full" aria-label="Raw stock recalculation">
        {tabs.map((t) => (
          <PillTabButton key={t.id} selected={activeTab === t.id} onClick={() => setActiveTab(t.id)}>
            {t.label}
            {t.id === "sources" && (sourceMismatches?.length ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-destructive/10 px-1.5 py-0.5 text-[11px] text-destructive">
                {sourceMismatches!.length}
              </span>
            )}
            {t.id === "audit" && (fullAudit?.summary.safeRepairsAvailable ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning">
                {fullAudit!.summary.safeRepairsAvailable}
              </span>
            )}
            {t.id === "partialfix" && (partialOffloadScan?.affected.length ?? 0) > 0 && (
              <span className="ml-1 rounded-full bg-info/10 px-1.5 py-0.5 text-[11px] text-info">
                {partialOffloadScan!.affected.length}
              </span>
            )}
          </PillTabButton>
        ))}
      </TabsList>

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
