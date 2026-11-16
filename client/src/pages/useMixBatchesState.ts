// Extracted from ./MixBatches.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useState } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import * as XLSX from "@/lib/excelHelper";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useMutation, useQuery } from "@tanstack/react-query";
import { exportFileName } from "@/lib/exportFile";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";

export const BatchDetail = lazy(() => import("./BatchDetail"));

interface UnlinkedBale {
  id: number;
  weightKg?: string;
  baleCode?: string;
  productName?: string;
  status?: string;
}

export function useMixBatchesState() {
  const { formatDisplayDate } = useDateFormat();
  const recordChanges = useExistingRecordChangeAccess();
  const canCreateBatch = recordChanges.canCreate("POST", "/api/factory/mix-batches");
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [sourceBatchId, setSourceBatchId] = useState<string>("");
  const [selectedBaleIds, setSelectedBaleIds] = useState<Set<number>>(new Set());

  // Edit state
  const [editBatch, setEditBatch] = useState<FactoryMixBatch | null>(null);

  // Delete state
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showAllBatches, setShowAllBatches] = useState(false);

  useEscapeBack(selectedBatchId !== null ? () => setSelectedBatchId(null) : null);
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const { data: batches, isLoading } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const deleteBatch = deleteId ? (batches?.find((b) => b.id === deleteId) ?? null) : null;

  const { data: unlinkedBales } = useQuery<UnlinkedBale[]>({
    queryKey: ["/api/factory/bales/unlinked"],
    enabled: assignDialogOpen,
  });

  const sourceBatch = sourceBatchId ? batches?.find((b) => b.id === parseInt(sourceBatchId)) : null;

  const availableKg = sourceBatch
    ? parseFloat(sourceBatch.totalWeightKg || "0") - parseFloat(sourceBatch.usedKg || "0")
    : 0;

  const selectedKg =
    unlinkedBales
      ?.filter((b) => selectedBaleIds.has(b.id))
      .reduce((sum: number, b) => sum + parseFloat(b.weightKg || "0"), 0) ?? 0;

  const overLimit = selectedKg > availableKg + 0.001;

  const assignMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/mix-batches/${sourceBatchId}/assign-bales`, {
        baleIds: Array.from(selectedBaleIds),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Assignment failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/unlinked"] });
      setAssignDialogOpen(false);
      setSourceBatchId("");
      setSelectedBaleIds(new Set());
      toast({ title: "Success", description: `${data.balesUpdated} bale(s) assigned to batch` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("DELETE", `/api/factory/mix-batches/${deleteId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/unlinked"] });
      setDeleteId(null);
      toast({ title: "Deleted", description: "Batch deleted. Bales have been unlinked and are preserved." });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const filteredBatches = batches?.filter((batch) => {
    if (statusFilter === "all") return true;
    return batch.status === statusFilter;
  });

  const activeBatchesWithStock =
    batches?.filter((b) => {
      const remaining = parseFloat(b.totalWeightKg || "0") - parseFloat(b.usedKg || "0");
      return remaining > 0.001;
    }) ?? [];

  const handleExportReport = async () => {
    if (!batches || batches.length === 0) {
      toast({ title: "No data to export" });
      return;
    }

    // Unique batch names (columns), sorted
    const batchNames = Array.from(new Set(batches.map((b) => (b.name || b.batchCode).toUpperCase()))).sort();

    // Unique dates, sorted
    const dates = Array.from(new Set(batches.filter((b) => b.batchDate).map((b) => b.batchDate as string))).sort();

    // Build date × name → kg map
    const matrix: Record<string, Record<string, number>> = {};
    for (const b of batches) {
      if (!b.batchDate) continue;
      const name = (b.name || b.batchCode).toUpperCase();
      const kg = parseFloat(b.totalWeightKg || "0");
      if (!matrix[b.batchDate]) matrix[b.batchDate] = {};
      matrix[b.batchDate][name] = (matrix[b.batchDate][name] || 0) + kg;
    }

    // Build row data
    const totals: Record<string, number> = {};
    const rows = dates.map((date) => {
      const row: Record<string, string | number> = { DATE: date };
      for (const name of batchNames) {
        const val = matrix[date]?.[name] || 0;
        row[name] = val > 0 ? val : "";
        totals[name] = (totals[name] || 0) + val;
      }
      return row;
    });

    // Total row
    const totalRow: Record<string, string | number> = { DATE: "TOTAL" };
    for (const name of batchNames) {
      totalRow[name] = totals[name] || "";
    }
    rows.push(totalRow);

    const ws = XLSX.utils.json_to_sheet(rows, { header: ["DATE", ...batchNames] });
    ws["!cols"] = [{ wch: 14 }, ...batchNames.map(() => ({ wch: 14 }))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mix Batches");
    await XLSX.writeFile(wb, exportFileName("mix batches", "xlsx"));
  };
  return {
    activeBatchesWithStock,
    assignDialogOpen,
    assignMutation,
    availableKg,
    canCreateBatch,
    createDialogOpen,
    deleteBatch,
    deleteId,
    deleteMutation,
    editBatch,
    filteredBatches,
    formatDisplayDate,
    handleExportReport,
    isLoading,
    overLimit,
    recordChanges,
    selectedBaleIds,
    selectedBatchId,
    selectedKg,
    setAssignDialogOpen,
    setCreateDialogOpen,
    setDeleteId,
    setEditBatch,
    setSelectedBaleIds,
    setSelectedBatchId,
    setShowAllBatches,
    setSourceBatchId,
    setStatusFilter,
    showAllBatches,
    sourceBatch,
    sourceBatchId,
    statusFilter,
    unlinkedBales,
  };
}
