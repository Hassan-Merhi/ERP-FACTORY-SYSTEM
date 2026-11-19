// Extracted from ./useFactoryPayroll.tsx: state, queries and mutations for useFactoryPayroll.
import { useState, useMemo } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { keepPreviousData, useQuery, useMutation } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient, apiRequest } from "@/lib/queryClient";
import type { FactoryWorker } from "@shared/schema";
import type { AttendanceEntry, CashAccount, PayrollGroup, PayrollRecord, PreviewWorkerRow } from "./types";

export function useFactoryPayrollDataModel() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();

  const [runOpen, setRunOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [payTargetId, setPayTargetId] = useState<number | null>(null);
  const [payCashAccountId, setPayCashAccountId] = useState("");
  const [payPaymentDate, setPayPaymentDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [bulkPayOpen, setBulkPayOpen] = useState(false);
  const [bulkCashAccountId, setBulkCashAccountId] = useState("");
  const [bulkPaymentDate, setBulkPaymentDate] = useState(new Date().toLocaleDateString("en-CA"));
  const [deleteTargetId, setDeleteTargetId] = useState<number | null>(null);
  const [undoTargetId, setUndoTargetId] = useState<number | null>(null);
  const [deleteBatchGroup, setDeleteBatchGroup] = useState<PayrollGroup | null>(null);
  const [showCompletedBatches, setShowCompletedBatches] = useState(false);
  const [projectionPeriod, setProjectionPeriod] = useState<"daily" | "weekly" | "biweekly" | "monthly">("monthly");
  const [repairOpen, setRepairOpen] = useState(false);
  const [repairResult, setRepairResult] = useState<{
    deletedPayrollVouchers: number;
    deletedAdvanceVouchers: number;
    total: number;
  } | null>(null);
  const [fixAcctOpen, setFixAcctOpen] = useState(false);
  const [fixAcctTargetId, setFixAcctTargetId] = useState<number | null>(null);
  const [fixAcctCashId, setFixAcctCashId] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  // Post-pay PDF state
  const [paidPayrollIds, setPaidPayrollIds] = useState<number[]>([]);
  const [printSummaryOpen, setPrintSummaryOpen] = useState(false);

  const _now = new Date();
  // Use local date parts to avoid UTC-offset stripping a day (e.g. UTC+3 midnight → previous UTC day)
  const _pad = (n: number) => String(n).padStart(2, "0");
  const _lastDayLocal = new Date(_now.getFullYear(), _now.getMonth() + 1, 0);
  const _lastDayOfMonth = `${_lastDayLocal.getFullYear()}-${_pad(_lastDayLocal.getMonth() + 1)}-${_pad(_lastDayLocal.getDate())}`;
  const _periodStartLocal = `${_now.getFullYear()}-${_pad(_now.getMonth() + 1)}-01`;

  const [runForm, setRunForm] = useState({
    periodStart: _periodStartLocal,
    periodEnd: _lastDayOfMonth,
    frequency: "Monthly",
    daysCount: "",
    bonusPerWorker: "",
    cashAccountId: "",
    targetAll: true,
    pickedWorkerIds: [] as number[],
    notes: "",
  });

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewRows, setPreviewRows] = useState<PreviewWorkerRow[]>([]);
  // advanceOverrides: workerId → approved deduction amount (string for input binding)
  const [advanceOverrides, setAdvanceOverrides] = useState<Record<number, string>>({});
  const [transportOverrides, setTransportOverrides] = useState<Record<number, string>>({});
  const [expandedAdvanceWorkers, setExpandedAdvanceWorkers] = useState<Set<number>>(new Set());
  const [attendanceDetail, setAttendanceDetail] = useState<{
    name: string;
    presentDates: AttendanceEntry[];
    absentDates: AttendanceEntry[];
    halfDayDates: AttendanceEntry[];
  } | null>(null);

  const { data: currentUser } = useQuery<{ role?: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = currentUser?.role === "Developer";

  const { data: payrolls, isLoading } = useQuery<PayrollRecord[]>({
    queryKey: ["/api/factory/payrolls"],
    queryFn: async () => {
      const res = await fetch("/api/factory/payrolls", { credentials: "include" });
      return res.json();
    },
  });

  const { data: workers } = useQuery<FactoryWorker[]>({
    queryKey: ["/api/factory/workers"],
    queryFn: async () => {
      const res = await fetch("/api/factory/workers", { credentials: "include" });
      return res.json();
    },
  });

  const { data: cashAccounts } = useQuery<CashAccount[]>({
    queryKey: ["/api/factory/cash-accounts"],
    queryFn: async () => {
      const res = await fetch("/api/factory/cash-accounts", { credentials: "include" });
      return res.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const activeWorkers = useMemo(() => workers?.filter((w) => w.active) || [], [workers]);

  // Projection: auto-compute date range from selected period
  const projDates = useMemo(() => {
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const fmtD = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (projectionPeriod === "daily") {
      const t = fmtD(now);
      return { start: t, end: t };
    }
    if (projectionPeriod === "weekly") {
      const s = new Date(now);
      s.setDate(now.getDate() - 6);
      return { start: fmtD(s), end: fmtD(now) };
    }
    if (projectionPeriod === "biweekly") {
      const s = new Date(now);
      s.setDate(now.getDate() - 13);
      return { start: fmtD(s), end: fmtD(now) };
    }
    // monthly — first to last of current month
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    return { start: fmtD(first), end: fmtD(last) };
  }, [projectionPeriod]);

  const { data: projectionRows, isFetching: projectionFetching } = useQuery<PreviewWorkerRow[]>({
    queryKey: ["/api/factory/payrolls/preview/projection", projDates.start, projDates.end],
    queryFn: async () => {
      const res = await apiRequest("POST", "/api/factory/payrolls/preview", {
        periodStart: projDates.start,
        periodEnd: projDates.end,
      });
      if (!res.ok) return [];
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    // Keep the last valid projection visible during background refreshes or period changes.
    // Never clear it to a loading placeholder after a successful response.
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });

  const projectionTotal = useMemo(() => (projectionRows ?? []).reduce((s, r) => s + (r.net ?? 0), 0), [projectionRows]);

  // Group payrolls by period
  const payrollGroups = useMemo((): PayrollGroup[] => {
    const map = new Map<string, PayrollGroup>();
    for (const p of payrolls || []) {
      const key = `${p.periodStart}|${p.periodEnd}`;
      if (!map.has(key)) {
        map.set(key, { key, periodStart: p.periodStart, periodEnd: p.periodEnd, records: [] });
      }
      map.get(key)!.records.push(p);
    }
    return Array.from(map.values());
  }, [payrolls]);

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const previewMutation = useMutation({
    mutationFn: async () => {
      const body: {
        periodStart: string;
        periodEnd: string;
        bonusPerWorker: string;
        workerIds?: number[];
        daysCount?: string;
      } = {
        periodStart: runForm.periodStart,
        periodEnd: runForm.periodEnd,
        bonusPerWorker: runForm.bonusPerWorker,
      };
      if (!runForm.targetAll) body.workerIds = runForm.pickedWorkerIds;
      if (runForm.daysCount) body.daysCount = runForm.daysCount;
      const res = await apiRequest("POST", "/api/factory/payrolls/preview", body);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load preview");
      return data as PreviewWorkerRow[];
    },
    onSuccess: (data) => {
      setPreviewRows(data);
      // Initialize overrides: default to full advance balance for each worker
      const overrides: Record<number, string> = {};
      const tOverrides: Record<number, string> = {};
      for (const row of data) {
        overrides[row.id] = row.totalAdvanceBalance.toFixed(2);
        tOverrides[row.id] = row.transportMonthly.toFixed(2);
      }
      setAdvanceOverrides(overrides);
      setTransportOverrides(tOverrides);
      setExpandedAdvanceWorkers(new Set());
      setPreviewOpen(true);
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const generateMutation = useMutation({
    mutationFn: async () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      // Convert advanceOverrides to numeric values keyed by workerId string
      const numericOverrides: Record<string, number> = {};
      for (const [wid, amt] of Object.entries(advanceOverrides)) {
        numericOverrides[wid] = parseFloat(amt) || 0;
      }
      const numericTransportOverrides: Record<string, number> = {};
      for (const [wid, amt] of Object.entries(transportOverrides)) {
        numericTransportOverrides[wid] = parseFloat(amt) || 0;
      }
      const body: Record<string, unknown> = {
        periodStart: runForm.periodStart,
        periodEnd: runForm.periodEnd,
        bonusPerWorker: runForm.bonusPerWorker,
        notes: runForm.notes,
        cashAccountId: runForm.cashAccountId || undefined,
        advanceOverrides: numericOverrides,
        transportOverrides: numericTransportOverrides,
      };
      if (!runForm.targetAll) body.workerIds = runForm.pickedWorkerIds;
      if (runForm.daysCount) body.daysCount = runForm.daysCount;
      const res = await apiRequest("POST", "/api/factory/payrolls/generate-bulk", body);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to generate payroll");
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/payrolls"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/advances/unvouchered"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/workers"] });
      toast({ title: "Payroll generated", description: `${data.created} records created` });
      setRunOpen(false);
      setPreviewOpen(false);
      // Auto-expand the new group
      const key = `${runForm.periodStart}|${runForm.periodEnd}`;
      setExpandedGroups((prev) => new Set([...prev, key]));
    },
    onError: (err: Error) => {
      if (err?._handledGlobally) return;
      toast({ title: "Generation failed", description: err.message, variant: "destructive" });
    },
  });

  return {
    formatDisplayDate,
    toast,
    recordChanges,
    runOpen,
    setRunOpen,
    payOpen,
    setPayOpen,
    payTargetId,
    setPayTargetId,
    payCashAccountId,
    setPayCashAccountId,
    payPaymentDate,
    setPayPaymentDate,
    selectedIds,
    setSelectedIds,
    bulkPayOpen,
    setBulkPayOpen,
    bulkCashAccountId,
    setBulkCashAccountId,
    bulkPaymentDate,
    setBulkPaymentDate,
    deleteTargetId,
    setDeleteTargetId,
    undoTargetId,
    setUndoTargetId,
    deleteBatchGroup,
    setDeleteBatchGroup,
    showCompletedBatches,
    setShowCompletedBatches,
    projectionPeriod,
    setProjectionPeriod,
    repairOpen,
    setRepairOpen,
    repairResult,
    setRepairResult,
    fixAcctOpen,
    setFixAcctOpen,
    fixAcctTargetId,
    setFixAcctTargetId,
    fixAcctCashId,
    setFixAcctCashId,
    expandedGroups,
    setExpandedGroups,
    paidPayrollIds,
    setPaidPayrollIds,
    printSummaryOpen,
    setPrintSummaryOpen,
    _now,
    _pad,
    _lastDayLocal,
    _lastDayOfMonth,
    _periodStartLocal,
    runForm,
    setRunForm,
    previewOpen,
    setPreviewOpen,
    previewRows,
    setPreviewRows,
    advanceOverrides,
    setAdvanceOverrides,
    transportOverrides,
    setTransportOverrides,
    expandedAdvanceWorkers,
    setExpandedAdvanceWorkers,
    attendanceDetail,
    setAttendanceDetail,
    currentUser,
    isDeveloper,
    payrolls,
    isLoading,
    workers,
    cashAccounts,
    activeWorkers,
    projDates,
    projectionRows,
    projectionFetching,
    projectionTotal,
    payrollGroups,
    toggleGroup,
    previewMutation,
    generateMutation,
  };
}
