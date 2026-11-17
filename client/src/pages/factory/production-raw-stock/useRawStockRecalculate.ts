import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { useAppMode } from "@/contexts/AppModeContext";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";

import type {
  AffectedMixBatchRow,
  FullAuditResult,
  HistoricalReplayApplyResponse,
  HistoricalReplayResult,
  PartialOffloadApplyResponse,
  PreparedReplayData,
  RecalcApplyResponse,
  RecalcRow,
  RestoreRatesResponse,
  SourceMismatchApplyResponse,
  SourceMismatchRow,
  SupplierRateAuditRow,
  SupplierRatePreviewResponse,
  SupplierRatePreviewRow,
  UndoApplyResponse,
  UndoLogRow,
} from "./rawstockrecalculate/types";

export function getRawStockErrorMessage(error: unknown, fallback = "An unexpected error occurred"): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function useRawStockRecalculate() {
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

  // ── Apply All Safe (full-scan batch repair) ───────────────────────────────
  const applyAllSafeMutation = useMutation({
    mutationFn: async ({
      includeHistoricalContainers,
      includeCompletedBatches,
    }: {
      includeHistoricalContainers: boolean;
      includeCompletedBatches: boolean;
    }) => {
      const dryRun = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/apply-all-safe", {
        includeHistoricalContainers,
        includeCompletedBatches,
      });
      if (!dryRun.ok) throw new Error((await dryRun.json()).message || "Failed to prepare apply-all-safe");
      const dryRunData = (await dryRun.json()) as RecalcApplyResponse & { confirmationToken?: string };
      if (!dryRunData.confirmationToken) {
        return dryRunData; // 0 safe containers — nothing to do
      }
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/apply-all-safe", {
        includeHistoricalContainers,
        includeCompletedBatches,
        confirm: true,
        confirmationToken: dryRunData.confirmationToken,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to apply safe repairs");
      return res.json() as Promise<RecalcApplyResponse>;
    },
    onSuccess: (data) => {
      if (!data.results) {
        toast({ title: "Nothing to repair", description: "All containers are already correct." });
        return;
      }
      const results = data.results || [];
      const applied = results.filter((r) => r.applied);
      const totalBatches = results.reduce((s, r) => s + r.affectedBatches, 0);
      const totalBales = results.reduce((s, r) => s + r.affectedBales, 0);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/full-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      toast({
        title: "All safe repairs applied",
        description: `Fixed ${applied.length} container(s). Updated ${totalBatches} mix batch(es) and ${totalBales} bale(s).`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Repair failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const handleApplyAllSafe = () => {
    const count = fullAudit?.summary.safeRepairsAvailable ?? "all";
    wrapAdminAction(() => {
      applyAllSafeMutation.mutate({ includeHistoricalContainers, includeCompletedBatches });
    }, `Apply all safe raw-material cost repairs (${count} container(s))`);
  };

  // ── Fix All Partial Offloads ───────────────────────────────────────────────
  // Filters the preview to PARTIALLY_RECEIVED containers that have a changed cost
  // and a resolved FX rate, then applies the recalculation with both historical
  // and completed-batch flags on — since partial offload containers span history.
  const partialOffloadCandidates = useMemo(
    () =>
      (rows || []).filter(
        // Catch historical containers already promoted to OFFLOADED by checking
        // wasPartialReceipt rather than containerStatus === "PARTIALLY_RECEIVED".
        (r) => r.changed && !r.fxUnresolved && r.wasPartialReceipt === true
      ),
    [rows]
  );

  const handleFixPartialOffloads = () => {
    if (partialOffloadCandidates.length === 0) return;
    const ids = partialOffloadCandidates.map((r) => r.containerId);
    wrapAdminAction(() => {
      applyMutation.mutate({
        containerIds: ids,
        includeHistoricalContainers: true,
        includeCompletedBatches: true,
      });
    }, `Fix cost on ${ids.length} PARTIALLY_RECEIVED container(s) — includes historical and completed batches`);
  };

  // ── Recompute supplier rates — dry-run first, then confirm ────────────────
  // Step 1: dry run — fetches preview without writing anything
  const recomputeDryRunMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/supplier-rate/recompute", { dryRun: true });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch recompute preview");
      return res.json() as Promise<SupplierRatePreviewResponse>;
    },
    onSuccess: (data) => {
      const changedRows = data.results.filter((r) => !r.skipped);
      if (changedRows.length === 0) {
        toast({
          title: "No changes needed",
          description: "All supplier rates already match the all-time stable average.",
        });
        return;
      }
      setRecomputePreviewRows(data.results);
      setShowRecomputeDialog(true);
    },
    onError: (err: unknown) => {
      toast({ title: "Preview failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  // DEFECT 12 FIX: recomputeApplyMutation removed — applying supplier rates via this
  // endpoint is deprecated. The dialog now shows a deprecation notice instead of an Apply
  // button (see the Recompute Supplier Rates dialog below). Use Historical Cost Replay.

  const handleRecomputeSupplierRates = () => {
    recomputeDryRunMutation.mutate();
  };

  // ── Restore supplier rates from audit log ─────────────────────────────────
  const restoreRatesMutation = useMutation({
    mutationFn: async (restorations: Array<{ supplierId: number; rate: number }>) => {
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/supplier-rate/restore-from-audit", {
        restorations,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to restore supplier rates");
      return res.json() as Promise<RestoreRatesResponse>;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/preview"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/supplier-rate/recompute-audit"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/source-cost-mismatches"] });
      setSelectedRestoreIds(new Set());
      toast({
        title: "Rates restored",
        description: `Restored ${data.restored} supplier rate(s). Refresh "Source Cost Mismatches" to see and fix affected batches.`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Restore failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const handleRestoreAll = () => {
    const rows = (rateAuditRows || []).filter((r) => r.canRestore);
    if (rows.length === 0) return;
    wrapAdminAction(
      () => restoreRatesMutation.mutate(rows.map((r) => ({ supplierId: r.supplierId, rate: r.oldRate }))),
      `Restore ${rows.length} supplier rate(s) to their pre-recompute moving-average values`
    );
  };

  const handleRestoreSelected = () => {
    const rows = (rateAuditRows || []).filter((r) => r.canRestore && selectedRestoreIds.has(r.supplierId));
    if (rows.length === 0) return;
    wrapAdminAction(
      () => restoreRatesMutation.mutate(rows.map((r) => ({ supplierId: r.supplierId, rate: r.oldRate }))),
      `Restore ${rows.length} supplier rate(s) to their pre-recompute moving-average values`
    );
  };

  // ── Fix ALL source mismatches — delegates to the working zero-cost-sources/apply path
  const fixAllSourcesMutation = { isPending: false }; // kept so JSX references compile

  const handleFixAllSources = () => {
    const fixable = fixableSourceMismatches;
    if (fixable.length === 0) return;
    const sourceIds = fixable.map((r) => r.sourceId);
    wrapAdminAction(
      () => sourceMismatchFixMutation.mutate({ sourceIds, rates: {} }),
      `Fix all ${fixable.length} fixable source cost mismatch(es)`
    );
  };

  // ── Fix source mismatches ─────────────────────────────────────────────────
  const sourceMismatchFixMutation = useMutation({
    mutationFn: async ({ sourceIds, rates }: { sourceIds: number[]; rates: Record<number, number> }) => {
      const dryRun = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/zero-cost-sources/apply", {
        sourceIds,
        manualRates: rates,
      });
      if (!dryRun.ok) throw new Error((await dryRun.json()).message || "Failed to prepare fix");
      const dryRunData = await dryRun.json();
      const res = await modeApiRequest("POST", "/api/factory/raw-stock/recalc/zero-cost-sources/apply", {
        sourceIds,
        manualRates: rates,
        confirm: true,
        confirmationToken: dryRunData.confirmationToken,
      });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to apply fix");
      return res.json() as Promise<SourceMismatchApplyResponse>;
    },
    onSuccess: (data) => {
      const results = data.results || [];
      const applied = results.filter((r) => r.applied);
      const totalBales = results.reduce((s, r) => s + (r.affectedBales || 0), 0);
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/source-cost-mismatches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/raw-stock/recalc/zero-cost-sources"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      setSelectedZeroCostSources(new Set());
      toast({
        title: "Source cost repairs applied",
        description: `Repaired ${applied.length} source(s). Updated ${totalBales} bale(s).`,
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Repair failed", description: getRawStockErrorMessage(err), variant: "destructive" });
    },
  });

  const handleFixSourceMismatches = () => {
    if (selectedZeroCostSources.size === 0) return;
    const rates: Record<number, number> = {};
    for (const id of selectedZeroCostSources) {
      const raw = manualRates[id];
      if (raw) {
        const parsed = parseFloat(raw);
        if (!isNaN(parsed) && parsed > 0) rates[id] = parsed;
      }
    }
    wrapAdminAction(() => {
      sourceMismatchFixMutation.mutate({ sourceIds: Array.from(selectedZeroCostSources), rates });
    }, `Repair source cost for ${selectedZeroCostSources.size} mix-batch source(s)`);
  };

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
