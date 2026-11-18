// Extracted from ./useRawStockRecalculate.ts to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import type {
  AffectedMixBatchRow,
  FullAuditResult,
  HistoricalReplayResult,
  PreparedReplayData,
  RecalcRow,
  SourceMismatchRow,
  SupplierRateAuditRow,
  SupplierRatePreviewRow,
  UndoLogRow,
} from "./rawstockrecalculate/types";

export function getRawStockErrorMessage(error: unknown, fallback = "An unexpected error occurred"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useRawStockRecalculatePart1() {
  const { toast } = useToast();
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [includeCompletedBatches, setIncludeCompletedBatches] = useState(false);
  const [includeHistoricalContainers, setIncludeHistoricalContainers] = useState(false);
  const [detailBatchId, setDetailBatchId] = useState<number | null>(null);
  const [selectedZeroCostSources, setSelectedZeroCostSources] = useState<Set<number>>(new Set());
  const [manualRates, setManualRates] = useState<Record<number, string>>({});
  const [expandedBatchSources, setExpandedBatchSources] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<"recalc" | "sources" | "audit" | "history" | "replay" | "partialfix">(
    "recalc"
  );

  // ── Historical Replay confirmation dialog (requires typing "APPLY HISTORICAL REPLAY") ──
  const [showReplayConfirmDialog, setShowReplayConfirmDialog] = useState(false);
  const [replayConfirmText, setReplayConfirmText] = useState("");
  const [includeFinalizedBales, setIncludeFinalizedBales] = useState(false);

  // FIX 11: Per-supplier selection for Historical Replay. Only safe suppliers that
  // are selected will be included in the Prepare call.
  const [selectedSupplierIds, setSelectedSupplierIds] = useState<Set<number>>(new Set());

  // DEFECT 3+9 FIX: Store the full dry-run response so the confirm dialog can
  // surface scope summary data and pass the STORED supplierIds on apply (not the
  // UI selection state which may have changed after Prepare was clicked).
  const [preparedReplayToken, setPreparedReplayToken] = useState<PreparedReplayData | null>(null);

  // ── Recompute dry-run / confirmation dialog ────────────────────────────────
  const [recomputePreviewRows, setRecomputePreviewRows] = useState<SupplierRatePreviewRow[] | null>(null);
  const [showRecomputeDialog, setShowRecomputeDialog] = useState(false);

  // ── Restore from audit — per-row selection ────────────────────────────────
  const [selectedRestoreIds, setSelectedRestoreIds] = useState<Set<number>>(new Set());

  // ── Main preview ──────────────────────────────────────────────────────────
  const {
    data: rows,
    isLoading,
    isError: isPreviewError,
    error: previewErrorMsg,
    refetch,
  } = useQuery<RecalcRow[]>({
    queryKey: ["/api/factory/raw-stock/recalc/preview"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/preview");
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Failed to load recalc preview");
      return res.json();
    },
    retry: false,
  });

  const changedRows = useMemo(() => (rows || []).filter((r) => r.changed), [rows]);
  const fxUnresolvedRows = useMemo(() => (rows || []).filter((r) => r.fxUnresolved), [rows]);
  const unchangedCount = (rows?.length || 0) - changedRows.length - fxUnresolvedRows.length;

  // Hide CLOSED/COMPLETED containers unless "include historical" is toggled
  const visibleChangedRows = useMemo(
    () =>
      includeHistoricalContainers
        ? changedRows
        : changedRows.filter((r) => !["CLOSED", "COMPLETED"].includes(r.containerStatus)),
    [changedRows, includeHistoricalContainers]
  );
  const hiddenHistoricalCount = changedRows.length - visibleChangedRows.length;

  const allSelected = visibleChangedRows.length > 0 && visibleChangedRows.every((r) => selected.has(r.containerId));
  const selectedIds = useMemo(() => Array.from(selected).sort((a, b) => a - b), [selected]);

  // ── Affected mix batches ──────────────────────────────────────────────────
  const { data: affectedBatches, isLoading: batchesLoading } = useQuery<AffectedMixBatchRow[]>({
    queryKey: ["/api/factory/raw-stock/recalc/mix-batches-preview", selectedIds, includeCompletedBatches],
    queryFn: async () => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/mix-batches-preview", {
        containerIds: selectedIds,
        includeCompletedBatches,
      });
      if (!res.ok) throw new Error("Failed to load affected mix batches");
      return res.json();
    },
    enabled: selectedIds.length > 0,
  });

  // ── Source cost mismatches (full scan, replaces zero-cost-only) ───────────
  const {
    data: sourceMismatches,
    isLoading: sourceMismatchLoading,
    refetch: refetchSources,
  } = useQuery<SourceMismatchRow[]>({
    queryKey: ["/api/factory/raw-stock/recalc/source-cost-mismatches"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/source-cost-mismatches");
      if (!res.ok) throw new Error("Failed to load source cost mismatches");
      return res.json();
    },
    enabled: activeTab === "sources",
  });

  const fixableSourceMismatches = useMemo(() => (sourceMismatches || []).filter((r) => r.fixable), [sourceMismatches]);
  const manualSourceMismatches = useMemo(
    () => (sourceMismatches || []).filter((r) => !r.fixable && r.containerId == null),
    [sourceMismatches]
  );
  const allSourceMismatchSelected =
    fixableSourceMismatches.length > 0 && fixableSourceMismatches.every((r) => selectedZeroCostSources.has(r.sourceId));

  // ── Full audit ────────────────────────────────────────────────────────────
  const {
    data: fullAudit,
    isLoading: auditLoading,
    refetch: refetchAudit,
  } = useQuery<FullAuditResult>({
    queryKey: ["/api/factory/raw-stock/recalc/full-audit"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/full-audit");
      if (!res.ok) throw new Error("Failed to run full audit");
      return res.json();
    },
    enabled: activeTab === "audit",
  });

  // ── Undo log ──────────────────────────────────────────────────────────────
  const {
    data: undoLog,
    isLoading: undoLogLoading,
    refetch: refetchUndoLog,
  } = useQuery<UndoLogRow[]>({
    queryKey: ["/api/factory/raw-stock/recalc/undo-log"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/undo-log");
      if (!res.ok) throw new Error("Failed to load undo log");
      return res.json();
    },
    enabled: activeTab === "history",
  });

  // ── Rate recompute audit (what did "Recompute Supplier Rates" overwrite?) ──
  const {
    data: rateAuditRows,
    isLoading: rateAuditLoading,
    refetch: refetchRateAudit,
  } = useQuery<SupplierRateAuditRow[]>({
    queryKey: ["/api/factory/raw-stock/supplier-rate/recompute-audit"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/supplier-rate/recompute-audit");
      if (!res.ok) throw new Error("Failed to load rate audit");
      return res.json();
    },
    enabled: activeTab === "history",
  });

  const restorableRows = useMemo(() => (rateAuditRows || []).filter((r) => r.canRestore), [rateAuditRows]);

  // ── Historical Cost Replay ────────────────────────────────────────────────
  const {
    data: replayPreview,
    isLoading: replayLoading,
    isError: isReplayError,
    error: replayErrorMsg,
    refetch: refetchReplay,
  } = useQuery<HistoricalReplayResult>({
    queryKey: ["/api/factory/raw-stock/recalc/historical-replay"],
    queryFn: async () => {
      const res = await modeApiRequest("GET", "/api/factory/raw-stock/recalc/historical-replay");
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).message || "Failed to load historical replay preview");
      return res.json();
    },
    enabled: activeTab === "replay",
    retry: false,
  });

  // FIX 12: Three-stage Prepare → Review → Apply flow.
  //
  // Stage 1 (Prepare) — dry-run call that issues a signed confirmation token.
  //   The "Prepare Historical Replay" button fires this mutation. On success it
  //   stores the token in `preparedReplayToken` and opens the confirm dialog.
  //
  // Stage 2 (Review) — the admin reads the exact scope shown in the dialog, types
  //   the confirmation phrase to prove intent, then clicks "Apply".
  //
  // Stage 3 (Apply) — uses the already-stored token. No second dry-run is needed;
  //   the route's fingerprint check guarantees the DB hasn't changed between stages.
  //
  // This separation means the token is fetched exactly once. In the old design a
  // single mutation fetched the token AND immediately consumed it in the same JS
  // microtask, so any mid-flight crash left an unconsumed token with no audit log.

  const replayPrepareMutation = useMutation({
    mutationFn: async (opts: {
      supplierIds: number[];
      forceSupplierIds: number[];
      includeCompletedBatches: boolean;
      includeFinalizedBales: boolean;
    }) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/historical-replay/apply", {
        dryRun: true,
        supplierIds: opts.supplierIds,
        forceSupplierIds: opts.forceSupplierIds,
        includeCompletedBatches: opts.includeCompletedBatches,
        includeFinalizedBales: opts.includeFinalizedBales,
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).message || "Dry-run failed");
      // DEFECT 9 FIX: return the full dry-run response, not just the token string.
      return res.json() as Promise<PreparedReplayData>;
    },
    onSuccess: (data) => {
      // DEFECT 9 FIX: store the full prepared-replay object, not just the token.
      setPreparedReplayToken(data);
      setReplayConfirmText("");
      setShowReplayConfirmDialog(true);
    },
    onError: (err: unknown) => {
      toast({ title: "Prepare failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });
  return {
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
  };
}
