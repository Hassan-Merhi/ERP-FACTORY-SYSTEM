// Extracted from ./RawStockReplayPanel.tsx: state, queries and handlers for RawStockReplayPanel.
import type { RawStockReplayPanelProps } from "./RawStockReplayPanel";

export function useRawStockReplayPanelModel({ rawStock }: { rawStock: RawStockReplayPanelProps["rawStock"] }) {
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

  return {
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
  };
}

export type RawStockReplayPanelModel = ReturnType<typeof useRawStockReplayPanelModel>;
