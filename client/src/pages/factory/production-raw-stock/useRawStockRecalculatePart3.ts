// Extracted from ./useRawStockRecalculate.ts to keep that module under the source-size cap.
import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type {
  RecalcApplyResponse,
  RestoreRatesResponse,
  SourceMismatchApplyResponse,
  SupplierRatePreviewResponse,
} from "./rawstockrecalculate/types";
import { getRawStockErrorMessage, useRawStockRecalculatePart1 } from "./getRawStockErrorMessage";
import { useRawStockRecalculatePart2 } from "./useRawStockRecalculatePart2";

export function useRawStockRecalculatePart3({
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
}: Pick<
  Awaited<ReturnType<typeof useRawStockRecalculatePart1>> & Awaited<ReturnType<typeof useRawStockRecalculatePart2>>,
  | "applyMutation"
  | "fixableSourceMismatches"
  | "fullAudit"
  | "includeCompletedBatches"
  | "includeHistoricalContainers"
  | "manualRates"
  | "modeApiRequest"
  | "rateAuditRows"
  | "rows"
  | "selectedRestoreIds"
  | "selectedZeroCostSources"
  | "setRecomputePreviewRows"
  | "setSelectedRestoreIds"
  | "setSelectedZeroCostSources"
  | "setShowRecomputeDialog"
  | "toast"
  | "wrapAdminAction"
>) {
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
  return {
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
  };
}
