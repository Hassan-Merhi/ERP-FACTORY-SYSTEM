import { useMutation, useQuery } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";

import type { PartialOffloadApplyResponse, RecalcRow } from "./rawstockrecalculate/types";
import { getRawStockErrorMessage, useRawStockRecalculatePart1 } from "./getRawStockErrorMessage";
import { useRawStockRecalculatePart2 } from "./useRawStockRecalculatePart2";
import { useRawStockRecalculatePart3 } from "./useRawStockRecalculatePart3";
export { getRawStockErrorMessage } from "./getRawStockErrorMessage";

export function useRawStockRecalculate() {
  const {
    AdminDialog,
    activeTab,
    affectedBatches,
    allSelected,
    allSourceMismatchSelected,
    auditLoading,
    batchesLoading,
    detailBatchId,
    expandedBatchSources,
    fixableSourceMismatches,
    fullAudit,
    fxUnresolvedRows,
    hiddenHistoricalCount,
    includeCompletedBatches,
    includeFinalizedBales,
    includeHistoricalContainers,
    isLoading,
    isPreviewError,
    isReplayError,
    manualRates,
    manualSourceMismatches,
    modeApiRequest,
    preparedReplayToken,
    previewErrorMsg,
    rateAuditLoading,
    rateAuditRows,
    recomputePreviewRows,
    refetch,
    refetchAudit,
    refetchRateAudit,
    refetchReplay,
    refetchSources,
    refetchUndoLog,
    replayConfirmText,
    replayErrorMsg,
    replayLoading,
    replayPrepareMutation,
    replayPreview,
    restorableRows,
    rows,
    selected,
    selectedIds,
    selectedRestoreIds,
    selectedSupplierIds,
    selectedZeroCostSources,
    setActiveTab,
    setDetailBatchId,
    setExpandedBatchSources,
    setIncludeCompletedBatches,
    setIncludeFinalizedBales,
    setIncludeHistoricalContainers,
    setManualRates,
    setPreparedReplayToken,
    setRecomputePreviewRows,
    setReplayConfirmText,
    setSelected,
    setSelectedRestoreIds,
    setSelectedSupplierIds,
    setSelectedZeroCostSources,
    setShowRecomputeDialog,
    setShowReplayConfirmDialog,
    showRecomputeDialog,
    showReplayConfirmDialog,
    sourceMismatchLoading,
    sourceMismatches,
    toast,
    unchangedCount,
    undoLog,
    undoLogLoading,
    visibleChangedRows,
    wrapAdminAction,
  } = useRawStockRecalculatePart1();
  const {
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
  } = useRawStockRecalculatePart2({
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
  });
  const {
    applyAllSafeMutation,
    fixAllSourcesMutation,
    handleApplyAllSafe,
    handleFixAllSources,
    handleFixPartialOffloads,
    handleFixSourceMismatches,
    handleRecomputeSupplierRates,
    handleRestoreAll,
    handleRestoreSelected,
    partialOffloadCandidates,
    recomputeDryRunMutation,
    restoreRatesMutation,
    sourceMismatchFixMutation,
  } = useRawStockRecalculatePart3({
    applyMutation,
    fixableSourceMismatches,
    fullAudit,
    includeCompletedBatches,
    includeHistoricalContainers,
    manualRates,
    modeApiRequest,
    rateAuditRows,
    rows,
    selectedRestoreIds,
    selectedZeroCostSources,
    setRecomputePreviewRows,
    setSelectedRestoreIds,
    setSelectedZeroCostSources,
    setShowRecomputeDialog,
    toast,
    wrapAdminAction,
  });
  const { partialOffloadApplyMutation, partialOffloadLoading, partialOffloadScan, refetchPartialOffload } =
    useRawStockRecalculatePart4({ activeTab, modeApiRequest, toast });

  return {
    wrapAdminAction,
    AdminDialog,
    selected,
    includeCompletedBatches,
    setIncludeCompletedBatches,
    includeHistoricalContainers,
    setIncludeHistoricalContainers,
    detailBatchId,
    setDetailBatchId,
    selectedZeroCostSources,
    manualRates,
    setManualRates,
    expandedBatchSources,
    activeTab,
    setActiveTab,
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
    selectedRestoreIds,
    setSelectedRestoreIds,
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
    refetchSources,
    fixableSourceMismatches,
    manualSourceMismatches,
    allSourceMismatchSelected,
    fullAudit,
    auditLoading,
    refetchAudit,
    undoLog,
    undoLogLoading,
    refetchUndoLog,
    rateAuditRows,
    rateAuditLoading,
    refetchRateAudit,
    restorableRows,
    replayPreview,
    replayLoading,
    isReplayError,
    replayErrorMsg,
    refetchReplay,
    replayPrepareMutation,
    replayApplyMutation,
    autoApplyFxMutation,
    undoMutation,
    handleUndo,
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
    recomputeDryRunMutation,
    handleRecomputeSupplierRates,
    restoreRatesMutation,
    handleRestoreAll,
    handleRestoreSelected,
    fixAllSourcesMutation,
    handleFixAllSources,
    sourceMismatchFixMutation,
    handleFixSourceMismatches,
    partialOffloadScan,
    partialOffloadLoading,
    refetchPartialOffload,
    partialOffloadApplyMutation,
  };
}

function useRawStockRecalculatePart4({
  activeTab,
  modeApiRequest,
  toast,
}: Pick<Awaited<ReturnType<typeof useRawStockRecalculatePart1>>, "activeTab" | "modeApiRequest" | "toast">) {
  // ── Partial-offload legacy fix scan ──────────────────────────────────────
  const {
    data: partialOffloadScan,
    isLoading: partialOffloadLoading,
    refetch: refetchPartialOffload,
  } = useQuery<{ affected: RecalcRow[]; skippedFx: RecalcRow[]; totalScanned: number }>({
    queryKey: ["/api/factory/raw-stock/recalc/partial-offload-scan"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/partial-offload-scan");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Scan failed");
      return res.json();
    },
    enabled: activeTab === "partialfix",
  });

  const partialOffloadApplyMutation = useMutation({
    mutationFn: async () => {
      const dryRun = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/partial-offload-scan/apply", {});
      if (!dryRun.ok) throw new Error((await dryRun.json()).message || "Dry-run failed");
      const dryRunData = await dryRun.json();
      if (!dryRunData.confirmationToken) {
        return dryRunData; // nothing to fix
      }
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/partial-offload-scan/apply", {
        confirm: true,
        confirmationToken: dryRunData.confirmationToken,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Apply failed");
      return res.json() as Promise<PartialOffloadApplyResponse>;
    },
    onSuccess: (data) => {
      if (!data.applied) {
        toast({ title: "Nothing to fix", description: "All partial-offload containers already have correct costs." });
        return;
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/partial-offload-scan"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      toast({
        title: "Partial-offload costs corrected",
        description: `Fixed ${data.applied} container(s). ${data.skipped} skipped.`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Fix failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });
  return { partialOffloadApplyMutation, partialOffloadLoading, partialOffloadScan, refetchPartialOffload };
}
