// Extracted from ./FactoryWorkerAttendanceReport.tsx to keep that module under the source-size cap.
import { useCallback, useMemo, useRef, useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import {
  AttendanceReportRequestError,
  readAttendanceReportResponse,
} from "./factoryworkerattendancereport/reportResponse";
import { validateAttendanceReportDateRange } from "@shared/attendanceReportDateRange";
import type {
  AttendanceFilter,
  AttendanceReportData,
  DateMode,
  WorkerReportRow,
} from "./factoryworkerattendancereport/types";
import {
  CYCLE,
  isoMonthEnd,
  isoMonthStart,
  isoToday,
  isoYesterday,
  MONTH_NAMES,
  workerCodeNum,
} from "./factoryworkerattendancereport/utils";
import {
  type AttendanceAdminCredentials,
  attendancePastDates,
  attendanceToday,
} from "./factoryattendance/attendanceEditPolicy";
import { useToast } from "@/hooks/use-toast";
import type { AttendanceReportRecord, AttendanceReportSavePayload } from "./FactoryWorkerAttendanceReportTypes";

export function useFactoryWorkerAttendanceReportState() {
  const qc = useQueryClient();
  const { toast } = useToast();

  /* Date mode state */
  const [mode, setMode] = useState<DateMode>("today");
  /* customStart/customEnd are used for both "thisMonth" navigation and "custom" range */
  const [customStart, setCustomStart] = useState(isoMonthStart);
  const [customEnd, setCustomEnd] = useState(isoMonthEnd);

  /* UI state */
  const [filter, setFilter] = useState<AttendanceFilter>("all");
  const [hideFullAbsent, setHideFullAbsent] = useState(false);
  const recordChanges = useExistingRecordChangeAccess(); // read-only roles never enter edit mode
  const [editModeRequested, setEditMode] = useState(false);
  const editMode = recordChanges.allowed && editModeRequested;

  /* Pending optimistic edits: "workerId|date" → status */
  const [pending, setPending] = useState<Record<string, string | undefined>>({});
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [approvalRecords, setApprovalRecords] = useState<AttendanceReportRecord[] | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Helper: navigate month offset for thisMonth mode */
  const navigateMonth = useCallback(
    (offset: number) => {
      const d = new Date(customStart + "T00:00:00");
      d.setMonth(d.getMonth() + offset);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const newStart = `${y}-${String(m).padStart(2, "0")}-01`;
      const lastDay = new Date(y, m, 0).getDate();
      const newEnd = `${y}-${String(m).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
      setCustomStart(newStart);
      setCustomEnd(newEnd);
      setMode("thisMonth");
    },
    [customStart]
  );

  /* Computed start/end from mode */
  const { startDate, endDate } = useMemo(() => {
    if (mode === "today") return { startDate: isoToday(), endDate: isoToday() };
    if (mode === "yesterday") return { startDate: isoYesterday(), endDate: isoYesterday() };
    if (mode === "thisMonth") return { startDate: customStart, endDate: customEnd };
    return { startDate: customStart, endDate: customEnd };
  }, [mode, customStart, customEnd]);

  const dateRangeError = useMemo(() => validateAttendanceReportDateRange(startDate, endDate), [startDate, endDate]);
  const queryKey = ["/api/factory/workers/attendance-report", startDate, endDate];

  const { data, isLoading, isError, error, refetch } = useQuery<AttendanceReportData>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/attendance-report?startDate=${startDate}&endDate=${endDate}`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      return readAttendanceReportResponse(res);
    },
    enabled: dateRangeError === null,
    // A proxy 502/503 can be transient. Do not retry denied, missing or malformed responses.
    retry: (failureCount, requestError) =>
      failureCount < 2 && (!(requestError instanceof AttendanceReportRequestError) || requestError.retryable),
    retryDelay: (failureCount) => Math.min(1000 * 2 ** failureCount, 3000),
  });

  /* Save changes using the same historical-date approval rule as the daily Attendance page. */
  const saveMutation = useMutation({
    // Save sequentially: a delayed response must never overwrite a newer status.
    scope: { id: "factory-worker-attendance-report" },
    mutationFn: async ({ records, credentials }: AttendanceReportSavePayload) => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      const validRecords = records.filter((r) => r.status !== "");
      const blankRecords = records.filter((r) => r.status === "");
      const promises: Promise<unknown>[] = [];
      if (validRecords.length > 0) {
        promises.push(
          apiRequest("POST", "/api/factory/attendance/bulk", {
            records: validRecords,
            ...credentials,
          })
        );
      }
      // Do not silently ignore a failed clear request (including a 404).
      for (const record of blankRecords) {
        promises.push(
          apiRequest("POST", "/api/factory/attendance/clear", {
            workerId: record.workerId,
            attendanceDate: record.attendanceDate,
            ...credentials,
          })
        );
      }
      await Promise.all(promises);
    },
    onSuccess: async (_result, { records, credentials }: AttendanceReportSavePayload) => {
      // Keep optimistic edits displayed until the refreshed server report arrives.
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["/api/factory/workers/attendance-report"] }),
        qc.invalidateQueries({ queryKey: ["/api/factory/attendance"] }),
      ]);
      // A newer edit to the same cell must not be discarded by an older response.
      setPending((current) => {
        const next = { ...current };
        for (const record of records) {
          const key = `${record.workerId}|${record.attendanceDate}`;
          if (next[key] === record.status) delete next[key];
        }
        return next;
      });
      if (credentials) {
        setApprovalOpen(false);
        setApprovalRecords(null);
        setApprovalDates([]);
      }
    },
    onError: (error: Error, { records, credentials }: AttendanceReportSavePayload) => {
      // A declined historical edit remains visible while the Admin retries.
      // For other failures, revert the rejected optimistic cells explicitly.
      if (!credentials) {
        setPending((current) => {
          const next = { ...current };
          for (const record of records) {
            const key = `${record.workerId}|${record.attendanceDate}`;
            if (next[key] === record.status) delete next[key];
          }
          return next;
        });
      }
      toast({
        title: "Attendance was not saved",
        description: error.message || "The attendance change was rejected. Please try again.",
        variant: "destructive",
      });
      qc.invalidateQueries({ queryKey: ["/api/factory/workers/attendance-report"] });
    },
  });

  /* Batch-save pending edits after short debounce, requesting Admin approval for earlier dates. */
  const flushPending = useCallback(
    (newPending: Record<string, string | undefined>) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        const entries = Object.entries(newPending);
        if (entries.length === 0) return;
        const records = entries.map(([key, status]) => {
          const [workerId, attendanceDate] = key.split("|");
          return { workerId: Number(workerId), attendanceDate, status: status ?? "" };
        });
        const priorDates = attendancePastDates(records.map((record) => record.attendanceDate));
        if (priorDates.length > 0) {
          setApprovalDates(priorDates);
          setApprovalRecords(records);
          setApprovalOpen(true);
        } else {
          saveMutation.mutate({ records });
        }
      }, 800);
    },
    [saveMutation]
  );

  const cycleCell = useCallback(
    (workerId: number, date: string, currentStatus?: string) => {
      if (date > attendanceToday()) {
        toast({ title: "Future dates cannot be edited", variant: "destructive" });
        return;
      }
      const key = `${workerId}|${date}`;
      const next = CYCLE[currentStatus ?? ""] ?? "Present";
      const newPending = { ...pending, [key]: next };
      setPending(newPending);
      flushPending(newPending);
    },
    [pending, flushPending, toast]
  );

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (approvalRecords) saveMutation.mutate({ records: approvalRecords, credentials });
  };

  const handleApprovalOpenChange = (open: boolean) => {
    if (!open && approvalRecords) {
      // Cancelling the approval must also cancel uncommitted optimistic changes.
      setPending((current) => {
        const next = { ...current };
        for (const record of approvalRecords) {
          const key = `${record.workerId}|${record.attendanceDate}`;
          if (next[key] === record.status) delete next[key];
        }
        return next;
      });
      setApprovalRecords(null);
      setApprovalDates([]);
    }
    setApprovalOpen(open);
  };

  /* Get effective status for a cell (optimistic override or server data) */
  const effectiveStatus = useCallback(
    (worker: WorkerReportRow, date: string): string | undefined => {
      const key = `${worker.id}|${date}`;
      return key in pending ? pending[key] : worker.attendance[date];
    },
    [pending]
  );

  /* Workers — sorted numerically by code */
  const sortedWorkers = useMemo(() => {
    if (!data) return [];
    return [...data.workers].sort((a, b) => workerCodeNum(a.employeeCode) - workerCodeNum(b.employeeCode));
  }, [data]);

  /* Filtered worker list */
  const filteredWorkers = useMemo(() => {
    let ws = sortedWorkers;
    if (hideFullAbsent) ws = ws.filter((w) => w.presentCount > 0 || w.recordedCount === 0);
    if (filter === "absent") ws = ws.filter((w) => w.absentCount > 0);
    if (filter === "present") ws = ws.filter((w) => w.absentCount === 0);
    return ws;
  }, [sortedWorkers, filter, hideFullAbsent]);

  /* Backend reconciles payroll, cash paid and advance settlements by period.
     Sum in cents so KPI/print totals agree exactly with stored payroll values. */
  const salaryKpi = useMemo(() => {
    if (!data || !data.dates.length) return null;
    let expectedCents = 0;
    let paidCents = 0;
    for (const w of filteredWorkers) {
      expectedCents += Math.round(Number(w.expectedSalary || "0") * 100);
      paidCents += Math.round(Number(w.paidSalary || "0") * 100);
    }
    return {
      totalExpected: expectedCents / 100,
      totalPaid: paidCents / 100,
      totalRemaining: (expectedCents - paidCents) / 100,
    };
  }, [filteredWorkers, data]);

  /* Counts for filter badges */
  const absentCount = sortedWorkers.filter((w) => w.absentCount > 0).length;
  const presentCount = sortedWorkers.filter((w) => w.absentCount === 0).length;
  const fullyAbsentCount = sortedWorkers.filter((w) => w.presentCount === 0 && w.recordedCount > 0).length;

  const overallPct =
    data && data.totals.presentDays + data.totals.absentDays > 0
      ? Math.round((data.totals.presentDays / (data.totals.presentDays + data.totals.absentDays)) * 100)
      : null;

  /* Range label for display */
  const rangeLabel = useMemo(() => {
    if (!data) {
      if (mode === "today") return "Today";
      if (mode === "yesterday") return "Yesterday";
      if (mode === "thisMonth") {
        const n = new Date();
        return `${MONTH_NAMES[n.getMonth()]} ${n.getFullYear()}`;
      }
      return `${customStart} → ${customEnd}`;
    }
    if (data.startDate === data.endDate) return data.startDate;
    if (data.dates.length > 0) {
      const s = data.dates[0];
      const e = data.dates[data.dates.length - 1];
      if (s.date.substring(0, 7) === e.date.substring(0, 7)) {
        const [yr, mo] = s.date.split("-");
        return `${MONTH_NAMES[parseInt(mo, 10) - 1]} ${yr}`;
      }
      return `${s.date} – ${e.date}`;
    }
    return `${data.startDate} – ${data.endDate}`;
  }, [data, mode, customStart, customEnd]);
  return {
    absentCount,
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    customEnd,
    customStart,
    cycleCell,
    data,
    dateRangeError,
    editMode,
    effectiveStatus,
    error,
    filter,
    filteredWorkers,
    flushPending,
    fullyAbsentCount,
    handleApprovalOpenChange,
    hideFullAbsent,
    isError,
    isLoading,
    mode,
    navigateMonth,
    overallPct,
    pending,
    presentCount,
    rangeLabel,
    recordChanges,
    refetch,
    salaryKpi,
    saveMutation,
    setCustomEnd,
    setCustomStart,
    setEditMode,
    setFilter,
    setHideFullAbsent,
    setMode,
    setPending,
    sortedWorkers,
  };
}
