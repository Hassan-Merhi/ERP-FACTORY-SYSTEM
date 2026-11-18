// Extracted from ./useRawStockRecalculate.ts to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type {
  HistoricalReplayApplyResponse,
  RecalcApplyResponse,
  UndoApplyResponse,
  UndoLogRow,
} from "./rawstockrecalculate/types";
import { getRawStockErrorMessage, useRawStockRecalculatePart1 } from "./getRawStockErrorMessage";

export function useRawStockRecalculatePart2({
  allSelected,
  allSourceMismatchSelected,
  fixableSourceMismatches,
  includeCompletedBatches,
  includeHistoricalContainers,
  modeApiRequest,
  refetchReplay,
  selected,
  setExpandedBatchSources,
  setPreparedReplayToken,
  setSelected,
  setSelectedZeroCostSources,
  toast,
  visibleChangedRows,
  wrapAdminAction,
}: Pick<
  Awaited<ReturnType<typeof useRawStockRecalculatePart1>>,
  | "allSelected"
  | "allSourceMismatchSelected"
  | "fixableSourceMismatches"
  | "includeCompletedBatches"
  | "includeHistoricalContainers"
  | "modeApiRequest"
  | "refetchReplay"
  | "selected"
  | "setExpandedBatchSources"
  | "setPreparedReplayToken"
  | "setSelected"
  | "setSelectedZeroCostSources"
  | "toast"
  | "visibleChangedRows"
  | "wrapAdminAction"
>) {
  const replayApplyMutation = useMutation({
    mutationFn: async (opts: {
      supplierIds: number[];
      includeCompletedBatches: boolean;
      includeFinalizedBales: boolean;
      confirmationToken: string;
    }) => {
      const applyRes = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/historical-replay/apply", {
        dryRun: false,
        confirmationToken: opts.confirmationToken,
        supplierIds: opts.supplierIds,
        includeCompletedBatches: opts.includeCompletedBatches,
        includeFinalizedBales: opts.includeFinalizedBales,
      });
      if (!applyRes.ok) throw new Error((await applyRes.json().catch(() => ({}))).message || "Apply failed");
      return applyRes.json() as Promise<HistoricalReplayApplyResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({
        title: "Historical replay applied",
        description:
          `Updated ${data.suppliersApplied} supplier(s), ` +
          `${data.sourcesUpdated} source(s), ` +
          `${data.batchesUpdated} batch(es), ` +
          `${data.balesUpdated} bale(s).`,
      });
      setPreparedReplayToken(null);
      refetchReplay();
    },
    onError: (err: unknown) => {
      toast({ title: "Historical replay failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const autoApplyFxMutation = useMutation({
    mutationFn: async (containerIds: number[]) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/auto-apply-fx", { containerIds });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to auto-apply FX");
      return res.json() as Promise<{
        results: { containerNumber: string; rate: number | null; applied: boolean; reason?: string }[];
        applied: number;
      }>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      const lines = data.results.map((r) =>
        r.applied ? `${r.containerNumber}: applied ${r.rate}` : `${r.containerNumber}: skipped (${r.reason})`
      );
      toast({ title: `FX applied to ${data.applied} container(s)`, description: lines.join(" · ") });
    },
    onError: (err: unknown) => {
      toast({ title: "Auto-apply FX failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async (undoLogId: number) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/undo", { undoLogId });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to undo");
      return res.json() as Promise<UndoApplyResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/undo-log"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({
        title: "Undo applied",
        description:
          `Restored ${data.containersRestored} container(s), ` +
          `${data.mixBatchesRestored} mix batch(es), ` +
          `${data.balesRestored} bale(s) to their previous values.`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Undo failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const handleUndo = (row: UndoLogRow) => {
    wrapAdminAction(
      () => {
        undoMutation.mutate(row.id);
      },
      `Undo recalculation applied ${new Date(row.appliedAt).toLocaleString()} — restores ${row.containerCount} container(s)`
    );
  };

  // ── Actions ───────────────────────────────────────────────────────────────
  const toggleAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(visibleChangedRows.map((r) => r.containerId)));
    }
  };
  const toggleOne = (containerId: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(containerId)) next.delete(containerId);
      else next.add(containerId);
      return next;
    });
  };

  const toggleSourceMismatch = (sourceId: number) => {
    setSelectedZeroCostSources((prev) => {
      const next = new Set(prev);
      if (next.has(sourceId)) next.delete(sourceId);
      else next.add(sourceId);
      return next;
    });
  };
  const toggleAllSourceMismatches = () => {
    if (allSourceMismatchSelected) {
      setSelectedZeroCostSources(new Set());
    } else {
      setSelectedZeroCostSources(new Set(fixableSourceMismatches.map((r) => r.sourceId)));
    }
  };

  const toggleBatchSourcesExpanded = (batchId: number) => {
    setExpandedBatchSources((prev) => {
      const next = new Set(prev);
      if (next.has(batchId)) next.delete(batchId);
      else next.add(batchId);
      return next;
    });
  };

  // ── Apply container cost recalculation ───────────────────────────────────
  const applyMutation = useMutation({
    mutationFn: async ({
      containerIds,
      includeCompletedBatches,
      includeHistoricalContainers,
    }: {
      containerIds: number[];
      includeCompletedBatches: boolean;
      includeHistoricalContainers: boolean;
    }) => {
      const dryRun = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/apply", {
        containerIds,
        includeCompletedBatches,
        includeHistoricalContainers,
      });
      if (!dryRun.ok) throw new Error((await dryRun.json()).message || "Failed to prepare recalculation");
      const dryRunData: RecalcApplyResponse & { confirmationToken?: string } = await dryRun.json();
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/apply", {
        containerIds,
        includeCompletedBatches,
        includeHistoricalContainers,
        confirm: true,
        confirmationToken: dryRunData.confirmationToken,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to apply recalculation");
      return res.json() as Promise<RecalcApplyResponse>;
    },
    onSuccess: (data) => {
      const results = data.results || [];
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/available-containers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales"] });
      setSelected(new Set());
      const applied = results.filter((r) => r.applied === true);
      const skipped = results.filter((r) => !r.applied);
      const totalBatches = results.reduce((s, r) => s + r.affectedBatches, 0);
      const totalBales = results.reduce((s, r) => s + r.affectedBales, 0);
      const totalCompleted = results.reduce((s, r) => s + (r.completedBatchesRewritten || 0), 0);
      const skipSummary =
        skipped.length > 0
          ? ` (${skipped.length} skipped: ${[...new Set(skipped.map((r) => r.skippedReason).filter(Boolean))].join("; ")})`
          : "";
      toast({
        title: "Recalculation applied",
        description:
          `Fixed ${applied.length} of ${results.length} container(s). Updated ${totalBatches} mix batch(es) and ${totalBales} bale(s).` +
          (totalCompleted > 0 ? ` (${totalCompleted} were completed/closed batches.)` : "") +
          skipSummary,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Recalculation failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const handleApply = () => {
    if (selected.size === 0) return;
    const label =
      `Apply cost recalculation to ${selected.size} container(s)` +
      (includeCompletedBatches ? ", including rewriting completed/closed mix batches" : "") +
      (includeHistoricalContainers ? ", including CLOSED/COMPLETED containers" : "");
    wrapAdminAction(() => {
      applyMutation.mutate({
        containerIds: Array.from(selected),
        includeCompletedBatches,
        includeHistoricalContainers,
      });
    }, label);
  };
  return {
    applyMutation,
    autoApplyFxMutation,
    handleApply,
    handleUndo,
    replayApplyMutation,
    toggleAll,
    toggleAllSourceMismatches,
    toggleBatchSourcesExpanded,
    toggleOne,
    toggleSourceMismatch,
    undoMutation,
  };
}
