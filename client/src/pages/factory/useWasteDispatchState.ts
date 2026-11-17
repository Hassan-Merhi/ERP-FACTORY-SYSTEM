// Extracted from ./WasteDispatch.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useWasteDispatchStatePart1 } from "./useWasteDispatchStatePart1";

export function useWasteDispatchState() {
  const {
    bales,
    confirming,
    deleteDispatchId,
    dispatchDate,
    expandedGroups,
    expandedHistoryIds,
    grandTotals,
    handleHistoryPrint,
    handleScan,
    history,
    isLoading,
    notes,
    printData,
    productGroups,
    scanInput,
    scanInputRef,
    scanReference,
    search,
    selected,
    setConfirming,
    setDeleteDispatchId,
    setDispatchDate,
    setNotes,
    setPrintData,
    setScanInput,
    setSearch,
    setSelected,
    setShowAllHistory,
    showAllHistory,
    toast,
    toggleAll,
    toggleBale,
    toggleExpandGroup,
    toggleGroup,
    toggleHistoryItem,
    totalCost,
    totalWeight,
  } = useWasteDispatchStatePart1();
  const { deleteDispatchMutation, submitMutation } = useWasteDispatchStatePart2({
    dispatchDate,
    notes,
    selected,
    setConfirming,
    setDeleteDispatchId,
    setNotes,
    setPrintData,
    setSelected,
    toast,
  });
  return {
    bales,
    confirming,
    deleteDispatchId,
    deleteDispatchMutation,
    dispatchDate,
    expandedGroups,
    expandedHistoryIds,
    grandTotals,
    handleHistoryPrint,
    handleScan,
    history,
    isLoading,
    notes,
    printData,
    productGroups,
    scanInput,
    scanInputRef,
    scanReference,
    search,
    selected,
    setConfirming,
    setDeleteDispatchId,
    setDispatchDate,
    setNotes,
    setPrintData,
    setScanInput,
    setSearch,
    setSelected,
    setShowAllHistory,
    showAllHistory,
    submitMutation,
    toggleAll,
    toggleBale,
    toggleExpandGroup,
    toggleGroup,
    toggleHistoryItem,
    totalCost,
    totalWeight,
  };
}

function useWasteDispatchStatePart2({
  dispatchDate,
  notes,
  selected,
  setConfirming,
  setDeleteDispatchId,
  setNotes,
  setPrintData,
  setSelected,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useWasteDispatchStatePart1>>,
  | "dispatchDate"
  | "notes"
  | "selected"
  | "setConfirming"
  | "setDeleteDispatchId"
  | "setNotes"
  | "setPrintData"
  | "setSelected"
  | "toast"
>) {
  // ── Dispatch mutation ──────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/factory/waste-dispatch/submit", {
        baleIds: [...selected],
        dispatchDate,
        notes: notes.trim() || undefined,
      });
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history"] });
      setSelected(new Set());
      setNotes("");
      setConfirming(false);
      setPrintData(result);
      toast({
        title: "Waste disposed",
        description: `${result.totalBales} bale(s) marked as disposed (${result.dispatch.dispatchNumber})`,
      });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
      setConfirming(false);
    },
  });

  // ── Delete dispatch mutation ───────────────────────────────────
  const deleteDispatchMutation = useMutation({
    mutationFn: async (id: number) => {
      const res = await apiRequest("DELETE", `/api/factory/waste-dispatch/${id}`);
      return res.json();
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/bales"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/waste-dispatch/history"] });
      setDeleteDispatchId(null);
      toast({
        title: "Dispatch deleted",
        description: `${result.restoredBales} bale(s) restored to stock.`,
      });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
      setDeleteDispatchId(null);
    },
  });
  return { deleteDispatchMutation, submitMutation };
}
