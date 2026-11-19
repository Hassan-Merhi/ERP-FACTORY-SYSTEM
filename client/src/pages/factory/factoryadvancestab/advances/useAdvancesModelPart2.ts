// Extracted from ./useAdvancesModel.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAdvancesModelPart1, wasHandledGlobally } from "./useAdvancesModelPart1";

export function useAdvancesModelPart2({
  advances,
  bulkAmounts,
  bulkCashAccountId,
  bulkForm,
  bulkSelected,
  filterWorker,
  form,
  recordChanges,
  selectedIds,
  setAddOpen,
  setBulkAmounts,
  setBulkCashAccountId,
  setBulkForm,
  setBulkOpen,
  setBulkSelected,
  setDeleteTarget,
  setForm,
  setRepayAuditOpen,
  setReverseTarget,
  setSelectedIds,
  toast,
}: Pick<
  Awaited<ReturnType<typeof useAdvancesModelPart1>>,
  | "advances"
  | "bulkAmounts"
  | "bulkCashAccountId"
  | "bulkForm"
  | "bulkSelected"
  | "filterWorker"
  | "form"
  | "recordChanges"
  | "repayAuditForm"
  | "selectedIds"
  | "setAddOpen"
  | "setBulkAmounts"
  | "setBulkCashAccountId"
  | "setBulkForm"
  | "setBulkOpen"
  | "setBulkSelected"
  | "setDeleteTarget"
  | "setForm"
  | "setRepayAuditOpen"
  | "setReverseTarget"
  | "setSelectedIds"
  | "toast"
>) {
  const repayAuditMutation = useMutation({
    mutationFn: async (form: ReturnType<typeof useAdvancesModelPart1>["repayAuditForm"]) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/post-repayment-vouchers", {
        cashAccountId: parseInt(form.cashAccountId),
        repaymentDate: form.repaymentDate,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed");
      return json;
    },
    onSuccess: (data) => {
      toast({ title: "Repayment entries posted", description: data.message });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/repayment-audit"] });
      setRepayAuditOpen(false);
    },
    onError: (err: Error) => {
      if (wasHandledGlobally(err)) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const [reconcileOpen, setReconcileOpen] = useState(false);

  interface ReconcileChange {
    advanceId: number;
    workerName: string;
    advanceDate: string;
    originalAmount: string;
    currentBalance: string;
    newBalance: string;
    currentFullyPaid: boolean;
    newFullyPaid: boolean;
    changed: boolean;
  }

  const { data: reconcilePreview, isLoading: reconcilePreviewLoading } = useQuery<{
    changes: ReconcileChange[];
    totalAdvances: number;
  }>({
    queryKey: ["/api/factory/advances/reconcile/preview"],
    queryFn: async () => {
      const res = await fetch("/api/factory/advances/reconcile/preview", { credentials: "include" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Preview failed");
      return json;
    },
    enabled: reconcileOpen,
    staleTime: 15000,
  });

  const reconcileMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/reconcile", {});
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Reconciliation failed");
      return json;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/reconcile/preview"] });
      toast({ title: "Reconciliation complete", description: data.message });
      setReconcileOpen(false);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Reconcile failed", description: err.message, variant: "destructive" });
    },
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/workers/${form.workerId}/advances`, {
        advanceDate: form.advanceDate,
        amount: form.amount,
        cashAccountId: form.cashAccountId ? parseInt(form.cashAccountId) : undefined,
        notes: form.notes || undefined,
        repaymentType: form.repaymentType,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to create advance");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Advance recorded" });
      setAddOpen(false);
      setForm({
        workerId: "",
        advanceDate: new Date().toLocaleDateString("en-CA"),
        amount: "",
        cashAccountId: "",
        notes: "",
        repaymentType: "salary_deduction",
      });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await fetch(`/api/factory/advances/${id}`, { method: "DELETE", credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Advance deleted" });
      setDeleteTarget(null);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Delete failed", description: err.message, variant: "destructive" });
    },
  });

  const reverseMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/advances/${id}/reverse`, {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to reverse advance");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Advance reversed", description: "Advance restored to outstanding — repayments removed." });
      setReverseTarget(null);
    },
    onError: (err: Error) => {
      if (wasHandledGlobally(err)) return;
      toast({ title: "Reversal failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const items = Array.from(bulkSelected)
        .map((wid) => ({ workerId: wid, amount: bulkAmounts[wid] || "" }))
        .filter((i) => parseFloat(i.amount) > 0);
      const res = await apiRequest("POST", "/api/factory/advances/bulk", {
        items,
        advanceDate: bulkForm.advanceDate,
        cashAccountId: bulkForm.cashAccountId ? parseInt(bulkForm.cashAccountId) : undefined,
        repaymentType: bulkForm.repaymentType,
        notes: bulkForm.notes || undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to create bulk advances");
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Bulk advances recorded", description: `${data.created} advance(s) created` });
      setBulkOpen(false);
      setBulkAmounts({});
      setBulkSelected(new Set());
      setBulkForm({
        advanceDate: new Date().toLocaleDateString("en-CA"),
        cashAccountId: "",
        repaymentType: "salary_deduction",
        notes: "",
      });
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkUpdateCashAccountMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/bulk-update-cash-account", {
        advanceIds: Array.from(selectedIds),
        cashAccountId: parseInt(bulkCashAccountId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to update cash accounts");
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      toast({ title: "Cash accounts updated", description: data.message });
      setSelectedIds(new Set());
      setBulkCashAccountId("");
    },
    onError: (err: Error) => {
      if (wasHandledGlobally(err)) return;
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const filtered = useMemo(() => {
    let list = Array.isArray(advances) ? advances : [];
    if (filterWorker !== "all") list = list.filter((a) => a.workerId === parseInt(filterWorker));
    return list;
  }, [advances, filterWorker]);

  const stats = useMemo(() => {
    const all = Array.isArray(advances) ? advances : [];
    const totalGiven = all.reduce((s, a) => s + parseFloat(a.amount || "0"), 0);
    const totalOutstanding = all
      .filter((a) => !a.fullyPaid)
      .reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
    const outstandingCount = all.filter((a) => !a.fullyPaid).length;
    return { totalGiven, totalOutstanding, outstandingCount, total: all.length };
  }, [advances]);
  return {
    bulkMutation,
    bulkUpdateCashAccountMutation,
    createMutation,
    deleteMutation,
    filtered,
    reconcileMutation,
    reconcileOpen,
    reconcilePreview,
    reconcilePreviewLoading,
    repayAuditMutation,
    reverseMutation,
    setReconcileOpen,
    stats,
  };
}
