import { useState, useMemo } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { FactoryWorker } from "@shared/schema";
import type { AdvanceRecord, AuditAdvance, CashAccount } from "../types";

function wasHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error && error._handledGlobally === true;
}

export function useAdvancesModel() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

  const [addOpen, setAddOpen] = useState(false);
  const [postAccountingOpen, setPostAccountingOpen] = useState(false);
  const [postCashAccountId, setPostCashAccountId] = useState("");
  const [filterWorker, setFilterWorker] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [deleteTarget, setDeleteTarget] = useState<AdvanceRecord | null>(null);
  const [reverseTarget, setReverseTarget] = useState<AdvanceRecord | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkCashAccountId, setBulkCashAccountId] = useState("");

  const [form, setForm] = useState({
    workerId: "",
    advanceDate: new Date().toLocaleDateString("en-CA"),
    amount: "",
    cashAccountId: "",
    notes: "",
    repaymentType: "salary_deduction" as string,
  });

  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkForm, setBulkForm] = useState({
    advanceDate: new Date().toLocaleDateString("en-CA"),
    cashAccountId: "",
    repaymentType: "salary_deduction" as string,
    notes: "",
  });
  const [bulkAmounts, setBulkAmounts] = useState<Record<number, string>>({});
  const [bulkSelected, setBulkSelected] = useState<Set<number>>(new Set());

  const { data: advances, isLoading } = useQuery<AdvanceRecord[]>({
    queryKey: ["/api/factory/advances", filterStatus],
    queryFn: async () => {
      const params = new URLSearchParams();
      if (filterStatus !== "all") params.set("status", filterStatus);
      const url = `/api/factory/advances${params.toString() ? `?${params}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to load advances");
      }
      return res.json();
    },
  });

  const { data: workers } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers?active=true"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const { data: unvouchered, isLoading: unvoucheredLoading } = useQuery<AdvanceRecord[]>({
    queryKey: ["/api/factory/advances/unvouchered"],
    queryFn: async () => {
      const res = await fetch("/api/factory/advances/unvouchered", { credentials: "include" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    enabled: postAccountingOpen,
  });

  const postAccountingMutation = useMutation({
    mutationFn: async (data: { cashAccountId: number }) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/post-accounting", data);
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed");
      return json;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      toast({ title: "Accounting posted", description: `${data.posted} advance(s) posted successfully` });
      setPostAccountingOpen(false);
      setPostCashAccountId("");
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const [repayByMonthOpen, setRepayByMonthOpen] = useState(false);
  const [repayByMonthForm, setRepayByMonthForm] = useState({
    repaymentDate: "",
    cashAccountId: "",
  });
  const [repayByMonthExpanded, setRepayByMonthExpanded] = useState<Set<string>>(new Set());
  const [repayingMonth, setRepayingMonth] = useState<string | null>(null);
  const [confirmRepay, setConfirmRepay] = useState<{
    monthKey: string;
    monthLabel: string;
    items: AdvanceRecord[];
    total: number;
  } | null>(null);

  const repayByMonthMutation = useMutation({
    mutationFn: async (month: string) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/repay-by-month", {
        month,
        repaymentDate: repayByMonthForm.repaymentDate,
        cashAccountId: parseInt(repayByMonthForm.cashAccountId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to repay");
      return { ...data, month };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advance-repayments"] });
      toast({
        title: "Repayments recorded",
        description: `${data.repaid} advance(s) repaid — total $${parseFloat(data.total).toFixed(2)}`,
      });
      setRepayingMonth(null);
    },
    onError: (err: Error) => {
      setRepayingMonth(null);
      if (wasHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const [cashAdjOpen, setCashAdjOpen] = useState(false);
  const [cashAdjForm, setCashAdjForm] = useState({
    cashAccountId: "",
    amount: "",
    direction: "credit",
    date: "",
    narration: "Cash balance adjustment",
  });
  const cashAdjMutation = useMutation({
    mutationFn: async (data: typeof cashAdjForm) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const res = await apiRequest("POST", "/api/factory/advances/cash-adjustment", {
        cashAccountId: parseInt(data.cashAccountId),
        amount: data.amount,
        direction: data.direction,
        date: data.date,
        narration: data.narration,
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message || "Failed");
      return json;
    },
    onSuccess: () => {
      toast({ title: "Adjustment posted", description: "Cash account balance corrected." });
      setCashAdjOpen(false);
      setCashAdjForm({
        cashAccountId: "",
        amount: "",
        direction: "credit",
        date: "",
        narration: "Cash balance adjustment",
      });
    },
    onError: (err: Error) => {
      if (wasHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const [repayAuditOpen, setRepayAuditOpen] = useState(false);
  const [repayAuditForm, setRepayAuditForm] = useState({ cashAccountId: "", repaymentDate: "" });

  interface AuditResult {
    advances: AuditAdvance[];
    summary: { total: number; ok: number; missingVoucher: number; noRepayment: number };
  }

  const {
    data: auditData,
    isLoading: auditLoading,
    refetch: refetchAudit,
  } = useQuery<AuditResult>({
    queryKey: ["/api/factory/advances/repayment-audit"],
    queryFn: async () => {
      const res = await fetch("/api/factory/advances/repayment-audit", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    enabled: repayAuditOpen,
    staleTime: 15000,
    refetchOnMount: true,
  });

  const { data: auditCashBalance } = useQuery<{ balance: string; name: string }>({
    queryKey: ["/api/factory/cash-account-balance", repayAuditForm.cashAccountId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/cash-account-balance/${repayAuditForm.cashAccountId}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch balance");
      return res.json();
    },
    enabled: !!repayAuditForm.cashAccountId && repayAuditOpen,
    staleTime: 15000,
    refetchOnMount: true,
  });

  const repayAuditMutation = useMutation({
    mutationFn: async (form: typeof repayAuditForm) => {
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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
      toast({ title: "Error", description: err.message, variant: "destructive" });
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

  const formatDate = (val: string | null | undefined) => {
    if (!val) return "\u2014";
    try {
      return formatDisplayDate(val);
    } catch {
      return "\u2014";
    }
  };
  return {
    canChangeExistingRecords: recordChanges.allowed,
    changeDisabledReason: recordChanges.reason,
    addOpen,
    setAddOpen,
    postAccountingOpen,
    setPostAccountingOpen,
    postCashAccountId,
    setPostCashAccountId,
    filterWorker,
    setFilterWorker,
    filterStatus,
    setFilterStatus,
    deleteTarget,
    setDeleteTarget,
    reverseTarget,
    setReverseTarget,
    selectedIds,
    setSelectedIds,
    bulkCashAccountId,
    setBulkCashAccountId,
    form,
    setForm,
    bulkOpen,
    setBulkOpen,
    bulkForm,
    setBulkForm,
    bulkAmounts,
    setBulkAmounts,
    bulkSelected,
    setBulkSelected,
    advances,
    isLoading,
    workers,
    cashAccounts,
    unvouchered,
    unvoucheredLoading,
    postAccountingMutation,
    repayByMonthOpen,
    setRepayByMonthOpen,
    repayByMonthForm,
    setRepayByMonthForm,
    repayByMonthExpanded,
    setRepayByMonthExpanded,
    repayingMonth,
    setRepayingMonth,
    confirmRepay,
    setConfirmRepay,
    repayByMonthMutation,
    cashAdjOpen,
    setCashAdjOpen,
    cashAdjForm,
    setCashAdjForm,
    cashAdjMutation,
    repayAuditOpen,
    setRepayAuditOpen,
    repayAuditForm,
    setRepayAuditForm,
    auditData,
    auditLoading,
    refetchAudit,
    auditCashBalance,
    repayAuditMutation,
    reconcileOpen,
    setReconcileOpen,
    reconcilePreview,
    reconcilePreviewLoading,
    reconcileMutation,
    createMutation,
    deleteMutation,
    reverseMutation,
    bulkMutation,
    bulkUpdateCashAccountMutation,
    filtered,
    stats,
    formatDate,
  };
}
