import { useMemo } from "react";
import { useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { PayrollGroup } from "./types";
import { useFactoryPayrollDataModel } from "./useFactoryPayrollDataModel";

/**
 * State, queries, mutations and derived values for the Factory payroll tab.
 * Extracted so the tab component is layout plus dialogs, each of which reads
 * what it needs from one typed object rather than a long props list.
 */
export default function useFactoryPayroll() {
  const hs = useFactoryPayrollDataModel();

  const markPaidMutation = useMutation({
    mutationFn: async ({ id, cashId, paymentDate }: { id: number; cashId: string; paymentDate: string }) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/mark-paid`, {
        cashAccountId: cashId ? parseInt(cashId) : undefined,
        paymentDate,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: (_, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      hs.setPaidPayrollIds([vars.id]);
      hs.setPrintSummaryOpen(true);
      hs.setPayOpen(false);
      hs.setPayTargetId(null);
      hs.setPayCashAccountId("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      hs.toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  const bulkMarkPaidMutation = useMutation({
    mutationFn: async ({ cashId, paymentDate }: { cashId: string; paymentDate: string }) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/payrolls/mark-paid-bulk", {
        payrollIds: [...hs.selectedIds],
        cashAccountId: cashId ? parseInt(cashId) : undefined,
        paymentDate,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      hs.setPaidPayrollIds([...hs.selectedIds]);
      hs.setPrintSummaryOpen(true);
      hs.setSelectedIds(new Set());
      hs.setBulkPayOpen(false);
      hs.setBulkCashAccountId("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      hs.toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  // A paid record must first reverse its payment posting and then remove the
  // generated draft. The undo API intentionally performs these as separate steps.
  const deletePayrollCompletely = async (id: number) => {
    if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
    const undo = async () => {
      const res = await apiRequest("POST", `/api/factory/payroll/${id}/undo`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to reverse payroll");
      }
      return res.json() as Promise<{ previousStatus: string }>;
    };
    const result = await undo();
    if (result.previousStatus === "PAID") {
      await undo();
    }
  };

  const deleteMutation = useMutation({
    mutationFn: deletePayrollCompletely,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      hs.toast({
        title: "Payroll deleted",
        description: "Payment postings reversed, payroll removed, and advances restored.",
      });
      hs.setDeleteTargetId(null);
    },
    onError: (err: Error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      if (err?._handledGlobally) return;
      hs.toast({
        title: "Payroll deletion incomplete",
        description: err.message + ". Reload the payroll to see its current status before retrying.",
        variant: "destructive",
      });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async (id: number) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("POST", `/api/factory/payroll/${id}/undo`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to undo");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      const msg =
        data.previousStatus === "PAID"
          ? "Payroll reverted to Draft — payment and accounting entries removed"
          : "Payroll deleted and advances restored";
      hs.toast({ title: "Undo successful", description: msg });
      hs.setUndoTargetId(null);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      hs.toast({ title: "Undo failed", description: err.message, variant: "destructive" });
    },
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (group: PayrollGroup) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      for (const p of group.records) {
        await deletePayrollCompletely(p.id);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      hs.toast({ title: "Batch deleted", description: "All records reversed and accounting entries removed." });
      hs.setDeleteBatchGroup(null);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      hs.toast({
        title: "Batch delete incomplete",
        description: err.message + ". Some records may already have been reversed; refresh before retrying.",
        variant: "destructive",
      });
    },
  });

  const repairMutation = useMutation({
    mutationFn: async () => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/repair-orphaned-vouchers", {});
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Repair failed");
      return data as { deletedPayrollVouchers: number; deletedAdvanceVouchers: number; total: number; message: string };
    },
    onSuccess: (data) => {
      hs.setRepairResult(data);
      queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
      hs.toast({
        title: "Ledger repaired",
        description: `${data.total} orphaned voucher${data.total !== 1 ? "s" : ""} removed`,
      });
    },
    onError: (e: Error) => hs.toast({ title: "Repair failed", description: e.message, variant: "destructive" }),
  });

  const fixAcctMutation = useMutation({
    mutationFn: async ({ id, cashId }: { id: number; cashId: string }) => {
      if (!hs.recordChanges.allowed) throw new Error(hs.recordChanges.reason ?? "");
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/fix-accounting`, {
        cashAccountId: parseInt(cashId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      hs.toast({
        title: "Accounting entry generated",
        description: "The payment voucher has been created for this payroll.",
      });
      hs.setFixAcctOpen(false);
      hs.setFixAcctTargetId(null);
      hs.setFixAcctCashId("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      hs.toast({ title: "Fix failed", description: err.message, variant: "destructive" });
    },
  });

  const printSummaryPDF = async () => {
    const res = await apiRequest("POST", "/api/factory/payrolls/payment-summary-pdf", {
      payrollIds: hs.paidPayrollIds,
    });
    if (!res.ok) {
      hs.toast({ title: "PDF failed", variant: "destructive" });
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  };

  const stats = useMemo(() => {
    const all = hs.payrolls || [];
    const uniqueWorkers = new Set(all.map((p) => p.workerId)).size;
    const pending = all.filter((p) => p.status !== "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0);
    const paid = all.filter((p) => p.status === "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0);
    return { uniqueWorkers, pending, paid };
  }, [hs.payrolls]);

  const toggleSelect = (id: number) => {
    hs.setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const unpaidPayrolls = (hs.payrolls || []).filter((p) => p.status !== "PAID");
  const allSelected = unpaidPayrolls.length > 0 && unpaidPayrolls.every((p) => hs.selectedIds.has(p.id));
  const activeGroups = hs.payrollGroups.filter((g) => g.records.some((p) => p.status !== "PAID"));
  const completedGroups = hs.payrollGroups.filter((g) => g.records.every((p) => p.status === "PAID"));

  return {
    canChangeExistingRecords: hs.recordChanges.allowed,
    canCreate: hs.recordChanges.canCreate,
    changeDisabledReason: hs.recordChanges.reason,
    formatDisplayDate: hs.formatDisplayDate,
    toast: hs.toast,
    runOpen: hs.runOpen,
    setRunOpen: hs.setRunOpen,
    payOpen: hs.payOpen,
    setPayOpen: hs.setPayOpen,
    payTargetId: hs.payTargetId,
    setPayTargetId: hs.setPayTargetId,
    payCashAccountId: hs.payCashAccountId,
    setPayCashAccountId: hs.setPayCashAccountId,
    payPaymentDate: hs.payPaymentDate,
    setPayPaymentDate: hs.setPayPaymentDate,
    selectedIds: hs.selectedIds,
    setSelectedIds: hs.setSelectedIds,
    bulkPayOpen: hs.bulkPayOpen,
    setBulkPayOpen: hs.setBulkPayOpen,
    bulkCashAccountId: hs.bulkCashAccountId,
    setBulkCashAccountId: hs.setBulkCashAccountId,
    bulkPaymentDate: hs.bulkPaymentDate,
    setBulkPaymentDate: hs.setBulkPaymentDate,
    deleteTargetId: hs.deleteTargetId,
    setDeleteTargetId: hs.setDeleteTargetId,
    undoTargetId: hs.undoTargetId,
    setUndoTargetId: hs.setUndoTargetId,
    deleteBatchGroup: hs.deleteBatchGroup,
    setDeleteBatchGroup: hs.setDeleteBatchGroup,
    showCompletedBatches: hs.showCompletedBatches,
    setShowCompletedBatches: hs.setShowCompletedBatches,
    projectionPeriod: hs.projectionPeriod,
    setProjectionPeriod: hs.setProjectionPeriod,
    repairOpen: hs.repairOpen,
    setRepairOpen: hs.setRepairOpen,
    repairResult: hs.repairResult,
    setRepairResult: hs.setRepairResult,
    fixAcctOpen: hs.fixAcctOpen,
    setFixAcctOpen: hs.setFixAcctOpen,
    fixAcctTargetId: hs.fixAcctTargetId,
    setFixAcctTargetId: hs.setFixAcctTargetId,
    fixAcctCashId: hs.fixAcctCashId,
    setFixAcctCashId: hs.setFixAcctCashId,
    expandedGroups: hs.expandedGroups,
    setExpandedGroups: hs.setExpandedGroups,
    paidPayrollIds: hs.paidPayrollIds,
    setPaidPayrollIds: hs.setPaidPayrollIds,
    printSummaryOpen: hs.printSummaryOpen,
    setPrintSummaryOpen: hs.setPrintSummaryOpen,
    _now: hs._now,
    _pad: hs._pad,
    _lastDayLocal: hs._lastDayLocal,
    _lastDayOfMonth: hs._lastDayOfMonth,
    _periodStartLocal: hs._periodStartLocal,
    runForm: hs.runForm,
    setRunForm: hs.setRunForm,
    previewOpen: hs.previewOpen,
    setPreviewOpen: hs.setPreviewOpen,
    previewRows: hs.previewRows,
    setPreviewRows: hs.setPreviewRows,
    advanceOverrides: hs.advanceOverrides,
    setAdvanceOverrides: hs.setAdvanceOverrides,
    transportOverrides: hs.transportOverrides,
    setTransportOverrides: hs.setTransportOverrides,
    expandedAdvanceWorkers: hs.expandedAdvanceWorkers,
    setExpandedAdvanceWorkers: hs.setExpandedAdvanceWorkers,
    attendanceDetail: hs.attendanceDetail,
    setAttendanceDetail: hs.setAttendanceDetail,
    currentUser: hs.currentUser,
    isDeveloper: hs.isDeveloper,
    payrolls: hs.payrolls,
    isLoading: hs.isLoading,
    workers: hs.workers,
    cashAccounts: hs.cashAccounts,
    activeWorkers: hs.activeWorkers,
    projDates: hs.projDates,
    projectionRows: hs.projectionRows,
    projectionFetching: hs.projectionFetching,
    projectionTotal: hs.projectionTotal,
    payrollGroups: hs.payrollGroups,
    toggleGroup: hs.toggleGroup,
    previewMutation: hs.previewMutation,
    generateMutation: hs.generateMutation,
    markPaidMutation,
    bulkMarkPaidMutation,
    deleteMutation,
    undoMutation,
    batchDeleteMutation,
    repairMutation,
    fixAcctMutation,
    printSummaryPDF,
    stats,
    toggleSelect,
    unpaidPayrolls,
    allSelected,
    activeGroups,
    completedGroups,
  };
}

export type FactoryPayrollState = ReturnType<typeof useFactoryPayroll>;
