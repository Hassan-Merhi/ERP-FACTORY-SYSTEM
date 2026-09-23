import { useState, useRef } from "react";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";

import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import type { FactoryWorker, FactoryBale, FactoryWorkerDocument, FactoryWorkerAdvance } from "@shared/schema";

import type { CashAccount, PayrollRecord, WorkerStats, WorkerWithStats } from "./types";
import { fmt } from "./utils";

interface WorkerDetailTabSettings {
  workerDetailTabStatementEnabled?: boolean;
  workerDetailTabAdvancesEnabled?: boolean;
  workerDetailTabBalesEnabled?: boolean;
  workerDetailTabDocumentsEnabled?: boolean;
}

interface WorkerDetailAccess {
  hiddenCostFields?: string[];
}

function isHandledGlobally(error: unknown): boolean {
  return typeof error === "object" && error !== null && "_handledGlobally" in error && Boolean(error._handledGlobally);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
export function useFactoryWorkerDetailModel() {
  const { wrapAdminAction, AdminDialog } = useAdminOverride();
  const [, navigate] = useLocation();
  useEscapeToParent("/factory/payroll-hub?tab=workers");
  const [, params] = useRoute("/factory/workers/:id");
  const workerId = params?.id ? parseInt(params.id) : null;
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [uploadingDoc, setUploadingDoc] = useState(false);
  const [viewingDoc, setViewingDoc] = useState<FactoryWorkerDocument | null>(null);

  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: tabSettings } = useQuery<WorkerDetailTabSettings>({
    queryKey: ["/api/factory/settings"],
    queryFn: async () => {
      const r = await fetch("/api/factory/settings");
      return r.ok ? r.json() : {};
    },
    staleTime: 60000,
  });

  const { data: myAccess } = useQuery<WorkerDetailAccess>({
    queryKey: ["/api/factory/my-access"],
    staleTime: 5 * 60000,
  });
  const hiddenTabs = myAccess?.hiddenCostFields ?? [];
  const showProfile = !hiddenTabs.includes("hide_tab_workerdetail_profile");

  const showStatement =
    tabSettings?.workerDetailTabStatementEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_statement");
  const showAdvances =
    tabSettings?.workerDetailTabAdvancesEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_advances");
  const showBales =
    tabSettings?.workerDetailTabBalesEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_bales");
  const showDocuments =
    tabSettings?.workerDetailTabDocumentsEnabled !== false && !hiddenTabs.includes("hide_tab_workerdetail_documents");

  const { formatDisplayDate } = useDateFormat();
  const formatDate = (val: string | Date | null | undefined) => {
    if (!val) return "—";
    try {
      return formatDisplayDate(val instanceof Date ? val : new Date(val));
    } catch {
      return "—";
    }
  };

  const [endStep, setEndStep] = useState<1 | 2>(1);
  const [endOpen, setEndOpen] = useState(false);
  const [endStart, setEndStart] = useState("");
  const [endEnd, setEndEnd] = useState(new Date().toLocaleDateString("en-CA"));
  const [endCalculating, setEndCalculating] = useState(false);
  const [endResult, setEndResult] = useState<{
    earned: string;
    paid: string;
    advances: string;
    balance: string;
  } | null>(null);
  const [endCashAccountId, setEndCashAccountId] = useState("");
  const [endSubmitting, setEndSubmitting] = useState(false);

  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  const [payOpen, setPayOpen] = useState(false);
  const [payTargetId, setPayTargetId] = useState<number | null>(null);
  const [payCashAccountId, setPayCashAccountId] = useState("");

  const [fixAcctOpen, setFixAcctOpen] = useState(false);
  const [fixAcctTargetId, setFixAcctTargetId] = useState<number | null>(null);
  const [fixAcctCashId, setFixAcctCashId] = useState("");

  const [detailPayrollId, setDetailPayrollId] = useState<number | null>(null);

  const [editOpen, setEditOpen] = useState(false);

  const [advanceDate, setAdvanceDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [advanceAmount, setAdvanceAmount] = useState("");
  const [advanceNotes, setAdvanceNotes] = useState("");
  const [advanceRepaymentType, setAdvanceRepaymentType] = useState("salary_deduction");
  const [advanceCashAccountId, setAdvanceCashAccountId] = useState("");
  const [showAdvanceForm, setShowAdvanceForm] = useState(false);

  const [repayAdvanceId, setRepayAdvanceId] = useState<number | null>(null);
  const [repayDate, setRepayDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [repayAmount, setRepayAmount] = useState("");
  const [repayCashAccountId, setRepayCashAccountId] = useState("");
  const [repayNotes, setRepayNotes] = useState("");
  const [expandedAdvanceId, setExpandedAdvanceId] = useState<number | null>(null);

  const [bulkRepayOpen, setBulkRepayOpen] = useState(false);
  const [bulkRepayCashAccountId, setBulkRepayCashAccountId] = useState("");
  const [bulkRepayDates, setBulkRepayDates] = useState<Record<number, string>>({});
  const [pendingDeleteDocId, setPendingDeleteDocId] = useState<number | null>(null);

  const getEndOfMonth = (dateStr: string): string => {
    const d = new Date(dateStr + "T00:00:00");
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    return lastDay.toLocaleDateString("en-CA");
  };

  const {
    data: worker,
    isLoading: workerLoading,
    error: workerError,
  } = useQuery<WorkerWithStats>({
    queryKey: ["/api/factory/workers", workerId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch worker");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: stats, isLoading: statsLoading } = useQuery<WorkerStats>({
    queryKey: ["/api/factory/workers", workerId, "stats"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/stats`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stats");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: payrolls, isLoading: payrollsLoading } = useQuery<PayrollRecord[]>({
    queryKey: ["/api/factory/workers", workerId, "payrolls"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/payrolls`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch payrolls");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: payrollDetail, isLoading: payrollDetailLoading } = useQuery<{
    payroll: PayrollRecord & {
      presentDays: string;
      absentDays: string;
      totalWorkingDays: number;
      balesCount: number;
      kgProcessed: string;
      overtimePay: string;
      overtimeHours: string;
      deductions: string;
      transport: string;
      notes: string | null;
    };
    attendance: { id: number; attendanceDate: string; status: string; shift: string | null; notes: string | null }[];
  }>({
    queryKey: ["/api/factory/payrolls", detailPayrollId, "detail"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/payrolls/${detailPayrollId}/detail`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch detail");
      return res.json();
    },
    enabled: detailPayrollId !== null,
  });

  const baleQueryString = [startDate && `startDate=${startDate}`, endDate && `endDate=${endDate}`]
    .filter(Boolean)
    .join("&");
  const { data: bales, isLoading: balesLoading } = useQuery<FactoryBale[]>({
    queryKey: ["/api/factory/workers", workerId, "bales", startDate, endDate],
    queryFn: async () => {
      const url = `/api/factory/workers/${workerId}/bales${baleQueryString ? `?${baleQueryString}` : ""}`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch bales");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: documents, isLoading: docsLoading } = useQuery<FactoryWorkerDocument[]>({
    queryKey: ["/api/factory/workers", workerId, "documents"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/documents`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch documents");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: workerAdvances, isLoading: advancesLoading } = useQuery<FactoryWorkerAdvance[]>({
    queryKey: ["/api/factory/workers", workerId, "advances"],
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/${workerId}/advances`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch advances");
      return res.json();
    },
    enabled: !!workerId,
  });

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const createAdvanceMutation = useMutation({
    mutationFn: async (data: {
      advanceDate: string;
      amount: string;
      notes: string;
      repaymentType: string;
      cashAccountId?: number;
    }) => {
      const res = await apiRequest("POST", `/api/factory/workers/${workerId}/advances`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "advances"] });
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
      const res = await apiRequest("POST", `/api/factory/advances/${data.advanceId}/repayments`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "advances"] });
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
      const res = await apiRequest("POST", `/api/factory/workers/${workerId}/bulk-repay-advances`, data);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "advances"] });
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
      const res = await apiRequest("DELETE", `/api/factory/advances/${advanceId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "advances"] });
      toast({ title: "Advance deleted" });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteDocMutation = useMutation({
    mutationFn: async (docId: number) => {
      const res = await apiRequest("DELETE", `/api/factory/workers/${workerId}/documents/${docId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed to delete");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "documents"] });
      toast({ title: "Document deleted" });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handleDocUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !workerId) return;
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
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "documents"] });
      toast({ title: "Document uploaded" });
    } catch (err: unknown) {
      toast({ title: "Upload failed", description: errorMessage(err), variant: "destructive" });
    } finally {
      setUploadingDoc(false);
    }
  };

  const markPaidMutation = useMutation({
    mutationFn: async ({ id, cashId }: { id: number; cashId: string }) => {
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/mark-paid`, {
        companyId: worker?.companyId,
        cashAccountId: cashId ? parseInt(cashId) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "advances"] });
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
      const res = await apiRequest("PATCH", `/api/factory/payrolls/${id}/fix-accounting`, {
        companyId: worker?.companyId,
        cashAccountId: parseInt(cashId),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "payrolls"] });
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
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/reactivate`, {});
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Failed");
      }
      return res.json();
    },
    onSuccess: (data: FactoryWorker) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Worker reactivated", description: `${data.fullName} is now active again.` });
    },
    onError: (err: Error) => {
      if (isHandledGlobally(err)) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const handlePhotoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !workerId) return;
    const fd = new FormData();
    fd.append("photo", file);
    try {
      const res = await fetch(`/api/factory/workers/${workerId}/photo`, {
        method: "POST",
        body: fd,
        credentials: "include",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Upload failed");
      }
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId] });
      toast({ title: "Photo updated" });
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    }
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const openEndContract = () => {
    if (!worker) return;
    setEndStep(1);
    setEndResult(null);
    setEndCashAccountId("");
    const today = new Date().toLocaleDateString("en-CA");
    const firstOfMonth = today.slice(0, 7) + "-01";
    setEndStart(worker.contractStartDate || worker.dateJoined || firstOfMonth);
    setEndEnd(today);
    setEndOpen(true);
  };

  const handleCalculate = async () => {
    if (!worker || !endStart || !endEnd) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndCalculating(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        startDate: endStart,
        endDate: endEnd,
        dryRun: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Calculation failed");
      setEndResult(data);
      setEndStep(2);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndCalculating(false);
    }
  };

  const handleEndContract = async (payNow: boolean) => {
    if (!worker) return;
    if (!navigator.onLine) {
      toast({
        title: "Not available offline",
        description: "Settle-and-end requires a connection",
        variant: "destructive",
      });
      return;
    }
    setEndSubmitting(true);
    try {
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        startDate: endStart,
        endDate: endEnd,
        payNow,
        cashAccountId: payNow ? endCashAccountId : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "payrolls"] });
      toast({
        title: "Contract ended",
        description: payNow ? `Paid ${fmt(data.balance)}` : "Balance recorded as pending",
      });
      setEndOpen(false);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndSubmitting(false);
    }
  };

  const handleSkipAndEnd = async () => {
    if (!worker) return;
    if (!navigator.onLine) {
      toast({ title: "Not available offline", description: "Requires a connection", variant: "destructive" });
      return;
    }
    setEndSubmitting(true);
    try {
      const today = new Date().toLocaleDateString("en-CA");
      const res = await factoryApiRequest("POST", `/api/factory/workers/${workerId}/settle-and-end`, {
        companyId: worker.companyId,
        endDate: endEnd || today,
        skipSettlement: true,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to end contract");
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers", workerId, "payrolls"] });
      toast({ title: "Contract ended", description: "Worker deactivated. No settlement payroll was created." });
      setEndOpen(false);
    } catch (err: unknown) {
      toast({ title: "Error", description: errorMessage(err), variant: "destructive" });
    } finally {
      setEndSubmitting(false);
    }
  };

  const payrollBalance = endResult ? parseFloat(endResult.balance) : 0;
  const totalPaidSalary =
    payrolls?.filter((p) => p.status === "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0) ?? 0;
  const totalPaidBonuses =
    payrolls?.filter((p) => p.status === "PAID").reduce((s, p) => s + parseFloat(p.bonuses || "0"), 0) ?? 0;
  const totalAdvancesGiven = workerAdvances?.reduce((s, a) => s + parseFloat(a.amount || "0"), 0) ?? 0;
  const totalPaid = totalPaidSalary;
  const totalPending =
    payrolls?.filter((p) => p.status !== "PAID").reduce((s, p) => s + parseFloat(p.netSalary || "0"), 0) ?? 0;
  const advancesLeft = (workerAdvances || [])
    .filter((a) => !a.fullyPaid)
    .reduce((s, a) => s + parseFloat(a.remainingBalance || "0"), 0);
  // netSalary already has advance deductions baked in, so subtract only the REMAINING advance balance to avoid double-counting
  const netBalance = totalPaidSalary + totalPaidBonuses - advancesLeft;

  return {
    AdminDialog,
    advanceAmount,
    advanceCashAccountId,
    advanceDate,
    advanceNotes,
    advanceRepaymentType,
    advancesLeft,
    advancesLoading,
    baleQueryString,
    bales,
    balesLoading,
    bulkRepayCashAccountId,
    bulkRepayDates,
    bulkRepayMutation,
    bulkRepayOpen,
    cashAccounts,
    createAdvanceMutation,
    currentUser,
    deleteAdvanceMutation,
    deleteDocMutation,
    detailPayrollId,
    docInputRef,
    docsLoading,
    documents,
    editOpen,
    endCalculating,
    endCashAccountId,
    endDate,
    endEnd,
    endOpen,
    endResult,
    endStart,
    endStep,
    endSubmitting,
    expandedAdvanceId,
    fileInputRef,
    fixAcctCashId,
    fixAcctMutation,
    fixAcctOpen,
    fixAcctTargetId,
    formatDate,
    formatDisplayDate,
    getEndOfMonth,
    handleCalculate,
    handleDocUpload,
    handleEndContract,
    handlePhotoUpload,
    handleSkipAndEnd,
    hiddenTabs,
    isDeveloper,
    markPaidMutation,
    myAccess,
    navigate,
    netBalance,
    openEndContract,
    params,
    payCashAccountId,
    payOpen,
    payTargetId,
    payrollBalance,
    payrollDetail,
    payrollDetailLoading,
    payrolls,
    payrollsLoading,
    pendingDeleteDocId,
    reactivateMutation,
    repayAdvanceId,
    repayAmount,
    repayCashAccountId,
    repayDate,
    repayNotes,
    repaymentMutation,
    setAdvanceAmount,
    setAdvanceCashAccountId,
    setAdvanceDate,
    setAdvanceNotes,
    setAdvanceRepaymentType,
    setBulkRepayCashAccountId,
    setBulkRepayDates,
    setBulkRepayOpen,
    setDetailPayrollId,
    setEditOpen,
    setEndCalculating,
    setEndCashAccountId,
    setEndDate,
    setEndEnd,
    setEndOpen,
    setEndResult,
    setEndStart,
    setEndStep,
    setEndSubmitting,
    setExpandedAdvanceId,
    setFixAcctCashId,
    setFixAcctOpen,
    setFixAcctTargetId,
    setPayCashAccountId,
    setPayOpen,
    setPayTargetId,
    setPendingDeleteDocId,
    setRepayAdvanceId,
    setRepayAmount,
    setRepayCashAccountId,
    setRepayDate,
    setRepayNotes,
    setShowAdvanceForm,
    setStartDate,
    setUploadingDoc,
    setViewingDoc,
    showAdvanceForm,
    showAdvances,
    showBales,
    showDocuments,
    showProfile,
    showStatement,
    startDate,
    stats,
    statsLoading,
    tabSettings,
    toast,
    totalAdvancesGiven,
    totalPaid,
    totalPaidBonuses,
    totalPaidSalary,
    totalPending,
    uploadingDoc,
    viewingDoc,
    worker,
    workerAdvances,
    workerError,
    workerId,
    workerLoading,
    wrapAdminAction,
  };
}
