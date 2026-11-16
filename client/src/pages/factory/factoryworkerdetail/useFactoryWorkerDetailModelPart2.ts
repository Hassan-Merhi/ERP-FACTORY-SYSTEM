// Extracted from ./useFactoryWorkerDetailModel.tsx to keep that module under the source-size cap.
import { useMutation } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactoryWorker } from "@shared/schema";
import { errorMessage, isHandledGlobally } from "./useFactoryWorkerDetailModelTypes";
import { useFactoryWorkerDetailModelPart1 } from "./useFactoryWorkerDetailModelPart1";

export function useFactoryWorkerDetailModelPart2({
  docInputRef,
  recordChanges,
  setAdvanceAmount,
  setAdvanceCashAccountId,
  setAdvanceNotes,
  setAdvanceRepaymentType,
  setBulkRepayCashAccountId,
  setBulkRepayDates,
  setBulkRepayOpen,
  setFixAcctCashId,
  setFixAcctOpen,
  setFixAcctTargetId,
  setPayCashAccountId,
  setPayOpen,
  setPayTargetId,
  setRepayAdvanceId,
  setRepayAmount,
  setRepayCashAccountId,
  setRepayNotes,
  setShowAdvanceForm,
  setUploadingDoc,
  toast,
  worker,
  workerId,
}: Pick<
  Awaited<ReturnType<typeof useFactoryWorkerDetailModelPart1>>,
  | "docInputRef"
  | "recordChanges"
  | "setAdvanceAmount"
  | "setAdvanceCashAccountId"
  | "setAdvanceNotes"
  | "setAdvanceRepaymentType"
  | "setBulkRepayCashAccountId"
  | "setBulkRepayDates"
  | "setBulkRepayOpen"
  | "setFixAcctCashId"
  | "setFixAcctOpen"
  | "setFixAcctTargetId"
  | "setPayCashAccountId"
  | "setPayOpen"
  | "setPayTargetId"
  | "setRepayAdvanceId"
  | "setRepayAmount"
  | "setRepayCashAccountId"
  | "setRepayNotes"
  | "setShowAdvanceForm"
  | "setUploadingDoc"
  | "toast"
  | "worker"
  | "workerId"
>) {
  const createAdvanceMutation = useMutation({
    mutationFn: async (data: {
      advanceDate: string;
      amount: string;
      notes: string;
      repaymentType: string;
      cashAccountId?: number;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/workers/${workerId}/advances`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Advance recorded" });
      setAdvanceAmount("");
      setAdvanceNotes("");
      setAdvanceRepaymentType("salary_deduction");
      setAdvanceCashAccountId("");
      setShowAdvanceForm(false);
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const repaymentMutation = useMutation({
    mutationFn: async (data: {
      advanceId: number;
      repaymentDate: string;
      amount: string;
      cashAccountId?: number;
      notes?: string;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/advances/${data.advanceId}/repayments`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances", vars.advanceId, "repayments"] });
      toast({ title: "Repayment recorded" });
      setRepayAdvanceId(null);
      setRepayAmount("");
      setRepayNotes("");
      setRepayCashAccountId("");
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const bulkRepayMutation = useMutation({
    mutationFn: async (data: {
      advances: { id: number; repaymentDate: string }[];
      cashAccountId?: number;
      notes?: string;
    }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/workers/${workerId}/bulk-repay-advances`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({
        title: `${data.count} advance${data.count !== 1 ? "s" : ""} repaid`,
        description: `Total: $${data.totalRepaid.toFixed(2)}`,
      });
      setBulkRepayOpen(false);
      setBulkRepayCashAccountId("");
      setBulkRepayDates({});
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteAdvanceMutation = useMutation({
    mutationFn: async (advanceId: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/factory/advances/${advanceId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Advance deleted" });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: async (docId: number) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("DELETE", `/api/factory/workers/${workerId}/documents/${docId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Document deleted" });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !workerId || !recordChanges.allowed) return;
    if (docInputRef.current) docInputRef.current.value = "";
    setUploadingDoc(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/factory/workers/${workerId}/documents`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Document uploaded" });
    } catch (err: unknown) {
      toast({ title: "Upload failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setUploadingDoc(false);
    }
  };

  const markPaidMutation = useMutation({
    mutationFn: async ({ id, cashId }: { id: number; cashId: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/mark-paid`, {
        companyId: worker?.companyId,
        cashAccountId: cashId ? parseInt(cashId) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Marked as paid" });
      setPayOpen(false);
      setPayTargetId(null);
      setPayCashAccountId("");
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const fixAcctMutation = useMutation({
    mutationFn: async ({ id, cashId }: { id: number; cashId: string }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/fix-accounting`, {
        companyId: worker?.companyId,
        cashAccountId: parseInt(cashId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Accounting entry generated" });
      setFixAcctOpen(false);
      setFixAcctTargetId(null);
      setFixAcctCashId("");
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const reactivateMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/reactivate`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (data: FactoryWorker) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Worker reactivated", description: `${data.fullName} is now active again.` });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });
  return {
    bulkRepayMutation,
    createAdvanceMutation,
    deleteAdvanceMutation,
    deleteDocMutation,
    fixAcctMutation,
    handleDocUpload,
    markPaidMutation,
    reactivateMutation,
    repaymentMutation,
  };
}
