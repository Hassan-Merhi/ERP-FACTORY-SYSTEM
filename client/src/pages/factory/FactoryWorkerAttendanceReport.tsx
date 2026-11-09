import { useState, useMemo, useCallback, useRef } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, CalendarDays, Printer, ChevronLeft, ChevronRight, Pencil, EyeOff, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
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
  MONTH_NAMES,
  fmtCurrency,
  isoMonthEnd,
  isoMonthStart,
  isoToday,
  isoYesterday,
  workerCodeNum,
} from "./factoryworkerattendancereport/utils";
import { StatusPill } from "./factoryworkerattendancereport/components/StatusPill";
import { AttendanceSummaryCards } from "./factoryworkerattendancereport/components/AttendanceSummaryCards";
import { AttendanceLegend } from "./factoryworkerattendancereport/components/AttendanceLegend";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import {
  attendancePastDates,
  attendanceToday,
  type AttendanceAdminCredentials,
} from "./factoryattendance/attendanceEditPolicy";
import { useToast } from "@/hooks/use-toast";

type AttendanceReportRecord = { workerId: number; attendanceDate: string; status: string };
type AttendanceReportSavePayload = {
  records: AttendanceReportRecord[];
  credentials?: AttendanceAdminCredentials;
};

export default function FactoryWorkerAttendanceReport() {
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

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-gradient-to-b from-blue-50/50 via-background to-background px-2 pb-4 text-foreground dark:from-[#0b172b] dark:via-[#0b1220] dark:to-[#0b1220] sm:px-4 sm:py-4 print:gap-3 print:rounded-none print:bg-white print:p-0 print:text-black">
      <AttendanceAdminApprovalDialog
        open={approvalOpen}
        onOpenChange={handleApprovalOpenChange}
        onApprove={approveAttendanceSave}
        isPending={saveMutation.isPending}
        dates={approvalDates}
      />
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3 print:hidden">
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-blue-400/30 bg-blue-500/10 text-blue-600 dark:text-blue-300">
            <CalendarDays className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-xl font-bold tracking-tight sm:text-2xl">Attendance Report</h2>
            <p className="text-xs text-muted-foreground">Workforce attendance and salary overview</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="default"
            onClick={() => window.print()}
            data-testid="button-print-report"
            className="gap-2 rounded-lg border border-blue-500 bg-blue-600 px-5 font-semibold text-white shadow-[0_5px_15px_rgba(37,99,235,0.25)] hover:bg-blue-700 hover:text-white dark:border-blue-400 dark:bg-blue-600 dark:hover:bg-blue-500 print:hidden"
          >
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
        </div>
      </div>

      {/* ── Date mode selector ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <span className="text-sm font-semibold text-muted-foreground">Period:</span>
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[#122037]">
          {(["today", "yesterday", "thisMonth", "custom"] as DateMode[]).map((m) => (
            <Button
              key={m}
              variant="ghost"
              size="sm"
              onClick={() => {
                if (m === "thisMonth") {
                  setCustomStart(isoMonthStart());
                  setCustomEnd(isoMonthEnd());
                }
                setMode(m);
              }}
              data-testid={`mode-${m}`}
              className={cn(
                "h-8 rounded-lg px-4 text-xs font-semibold transition-colors",
                mode === m
                  ? "bg-blue-600 text-white shadow-[0_2px_10px_rgba(37,99,235,0.35)] hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:hover:bg-blue-500"
                  : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
              )}
            >
              {m === "today" ? "Today" : m === "yesterday" ? "Yesterday" : m === "thisMonth" ? "This Month" : "Custom"}
            </Button>
          ))}
        </div>

        {/* Month navigator for thisMonth */}
        {mode === "thisMonth" && (
          <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[#122037]">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigateMonth(-1)}
              data-testid="button-prev-month"
              className="h-7 w-7"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <span className="text-xs font-semibold px-2 select-none" data-testid="text-current-month">
              {rangeLabel}
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => navigateMonth(1)}
              data-testid="button-next-month"
              className="h-7 w-7"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}

        {/* Custom range inputs */}
        {mode === "custom" && (
          <div className="flex items-center gap-2">
            <input
              type="date"
              value={customStart}
              onChange={(e) => setCustomStart(e.target.value)}
              data-testid="input-custom-start"
              className="h-7 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
            <span className="text-xs text-muted-foreground">–</span>
            <input
              type="date"
              value={customEnd}
              onChange={(e) => setCustomEnd(e.target.value)}
              data-testid="input-custom-end"
              className="h-7 rounded-md border bg-background px-2 text-xs focus:outline-hidden focus:ring-1 focus:ring-ring"
            />
          </div>
        )}
      </div>

      {/* ── Filter + toggle bar ─────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3 print:hidden">
        <span className="text-sm font-semibold text-muted-foreground">Show:</span>
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[#122037]">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("all")}
            data-testid="filter-all"
            className={cn(
              "h-8 rounded-lg px-3 text-xs font-semibold transition-colors",
              filter === "all"
                ? "bg-blue-600 text-white shadow-sm hover:bg-blue-700 hover:text-white dark:bg-blue-600"
                : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
            )}
          >
            All
            {data && (
              <Badge variant="secondary" className="ml-1.5 text-[11px] px-1.5 py-0 h-4">
                {sortedWorkers.length}
              </Badge>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("present")}
            data-testid="filter-present"
            className={cn(
              "h-8 rounded-lg px-3 text-xs font-semibold transition-colors",
              filter === "present"
                ? "bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-500/20 dark:text-emerald-300"
                : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
            )}
          >
            No Absences
            {data && (
              <Badge variant="outline" className="ml-1.5 text-[11px] px-1.5 py-0 h-4 status-success">
                {presentCount}
              </Badge>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("absent")}
            data-testid="filter-absent"
            className={cn(
              "h-8 rounded-lg px-3 text-xs font-semibold transition-colors",
              filter === "absent"
                ? "bg-red-100 text-red-800 hover:bg-red-200 dark:bg-red-500/20 dark:text-red-300"
                : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
            )}
          >
            Has Absences
            {data && (
              <Badge variant="outline" className="ml-1.5 text-[11px] px-1.5 py-0 h-4 status-danger">
                {absentCount}
              </Badge>
            )}
          </Button>
        </div>

        {/* Hide fully-absent toggle */}
        {fullyAbsentCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHideFullAbsent((v) => !v)}
            data-testid="toggle-hide-full-absent"
            className={cn(
              "h-9 gap-1.5 rounded-lg border-slate-200 px-3 text-xs font-semibold dark:border-blue-900/60 dark:bg-[#122037]",
              hideFullAbsent &&
                "border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-500/15 dark:text-blue-300"
            )}
          >
            {hideFullAbsent ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {hideFullAbsent ? "Show" : "Hide"} fully absent
            <Badge
              variant="secondary"
              className="text-[11px] px-1.5 py-0 h-4 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400"
            >
              {fullyAbsentCount}
            </Badge>
          </Button>
        )}

        {/* Edit mode toggle */}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEditMode((v) => !v)}
          data-testid="toggle-edit-mode"
          hidden={!recordChanges.allowed}
          className={cn(
            "h-9 gap-1.5 rounded-lg border-slate-200 px-3 text-xs font-semibold dark:border-blue-900/60 dark:bg-[#122037]",
            editMode &&
              "border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-500/15 dark:text-blue-300"
          )}
        >
          <Pencil className="h-3.5 w-3.5" />
          {editMode ? "Editing" : "Edit"}
          {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        </Button>
      </div>

      {dateRangeError && (
        <Card>
          <CardContent className="p-4 text-sm text-muted-foreground">{dateRangeError}</CardContent>
        </Card>
      )}

      {/* ── Loading / Error ─────────────────────────────────────────────────── */}
      {isLoading && (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-7 w-7 animate-spin text-muted-foreground" />
        </div>
      )}

      {isError && (
        <Card>
          <CardContent className="p-6 flex flex-col items-center gap-3">
            <p className="text-muted-foreground text-sm">{(error as Error)?.message || "Failed to load"}</p>
            <Button variant="outline" onClick={() => refetch()}>
              Try Again
            </Button>
          </CardContent>
        </Card>
      )}

      {data && !isLoading && (
        <>
          {/* ── Print header (hidden on screen) ─────────────────────────────── */}
          <div className="hidden print:block mb-4">
            <PageHeader title="Worker Attendance Report" />
            <p className="text-sm text-gray-600">{rangeLabel}</p>
            {salaryKpi && (
              <div className="mt-2 text-sm text-gray-700 flex gap-6">
                <span>Expected: {fmtCurrency(salaryKpi.totalExpected)}</span>
                <span>Paid: {fmtCurrency(salaryKpi.totalPaid)}</span>
                <span>Remaining: {fmtCurrency(salaryKpi.totalRemaining)}</span>
              </div>
            )}
          </div>

          {/* ── Summary cards ───────────────────────────────────────────────── */}
          <AttendanceSummaryCards filteredWorkers={filteredWorkers} overallPct={overallPct} salaryKpi={salaryKpi} />

          {/* ── Edit mode hint ───────────────────────────────────────────────── */}
          {editMode && (
            <div className="flex items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/70 px-4 py-3 text-xs text-muted-foreground dark:border-blue-800/50 dark:bg-blue-900/20 print:hidden">
              <Pencil className="h-3.5 w-3.5 shrink-0" />
              Click a cell to cycle: P → A → L → H → Clear. Or press{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[11px]">P</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[11px]">A</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[11px]">L</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[11px]">H</kbd> when focused.{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[11px]">Del</kbd> clears.
            </div>
          )}

          {/* ── No workers state ────────────────────────────────────────────── */}
          {data.workers.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                No workers or payroll records found for this period.
              </CardContent>
            </Card>
          ) : filteredWorkers.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                No workers match the selected filter.
              </CardContent>
            </Card>
          ) : (
            /* ── Attendance grid ────────────────────────────────────────────── */
            <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] dark:border-blue-900/70 dark:bg-[#0c172a] dark:shadow-[0_16px_32px_rgba(0,0,0,0.2)] print:max-h-none print:overflow-visible print:rounded-none print:border-0 print:bg-white print:shadow-none">
              <table className="w-full text-xs border-collapse min-w-max print:text-[11px]">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 dark:bg-[#172b49] dark:text-slate-200 print:bg-gray-100 print:text-black">
                    <th className="sticky left-0 top-0 z-30 min-w-[88px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-left font-semibold dark:border-[#2b4060] dark:bg-[#172b49] print:bg-gray-100">
                      Code
                    </th>
                    <th className="sticky left-[88px] top-0 z-30 min-w-[160px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-left font-semibold dark:border-[#2b4060] dark:bg-[#172b49] print:bg-gray-100">
                      Worker
                    </th>
                    {data.dates.map(({ date, label, abbr, isWeekend }) => (
                      <th
                        key={date}
                        className={cn(
                          "sticky top-0 z-20 w-8 min-w-[32px] border-b border-r border-slate-200 px-0 py-2 text-center font-semibold dark:border-[#2b4060]",
                          isWeekend
                            ? "bg-amber-50/80 text-amber-600 dark:bg-[#3d301f] dark:text-amber-300"
                            : "bg-slate-100 dark:bg-[#172b49]"
                        )}
                      >
                        <div className="flex flex-col items-center gap-0 leading-tight">
                          <span className="text-[11px] text-muted-foreground font-normal">{abbr}</span>
                          <span className="text-[11px] font-semibold">{label}</span>
                        </div>
                      </th>
                    ))}
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold text-emerald-700 dark:border-[#2b4060] dark:bg-[#172b49] dark:text-emerald-300 print:bg-gray-100">
                      P
                    </th>
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold text-red-500 dark:border-[#2b4060] dark:bg-[#172b49] dark:text-red-400 print:bg-gray-100">
                      A
                    </th>
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold dark:border-[#2b4060] dark:bg-[#172b49] print:bg-gray-100">
                      %
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filteredWorkers.map((worker, idx) => (
                    <tr
                      key={worker.id}
                      className={cn(
                        "border-b border-slate-100 transition-colors hover:bg-blue-50/70 dark:border-[#253651] dark:hover:bg-[#1a3456]",
                        idx % 2 === 0 ? "bg-white dark:bg-[#0c172a]" : "bg-slate-50/70 dark:bg-[#101e33]"
                      )}
                      data-testid={`row-worker-${worker.id}`}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-10 border-r border-slate-100 px-3 py-2 font-mono text-muted-foreground dark:border-[#253651]",
                          idx % 2 === 0 ? "bg-white dark:bg-[#0c172a]" : "bg-slate-50/70 dark:bg-[#101e33]"
                        )}
                      >
                        {worker.employeeCode || "—"}
                      </td>
                      <td
                        className={cn(
                          "sticky left-[88px] z-10 whitespace-nowrap border-r border-slate-100 px-3 py-2 font-semibold dark:border-[#253651]",
                          idx % 2 === 0 ? "bg-white dark:bg-[#0c172a]" : "bg-slate-50/70 dark:bg-[#101e33]"
                        )}
                      >
                        <span className="truncate block max-w-[180px]" title={worker.fullName}>
                          {worker.fullName}
                        </span>
                        {worker.active === false && (
                          <span className="mt-0.5 inline-block rounded border border-amber-400/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                            Inactive
                          </span>
                        )}
                      </td>

                      {data.dates.map(({ date, isWeekend }) => {
                        const status = effectiveStatus(worker, date);
                        return (
                          <td
                            key={date}
                            className={cn(
                              "w-8 border-r border-slate-100 px-0 py-2 text-center dark:border-[#253651]",
                              isWeekend ? "bg-amber-50/40 dark:bg-amber-900/5" : ""
                            )}
                            data-testid={`cell-${worker.id}-${date}`}
                          >
                            <div className="flex items-center justify-center">
                              <StatusPill
                                status={status}
                                absentsOnly={filter === "absent"}
                                editable={editMode && worker.active !== false && date <= attendanceToday()}
                                onClick={
                                  editMode && worker.active !== false && date <= attendanceToday()
                                    ? () => cycleCell(worker.id, date, status)
                                    : undefined
                                }
                                onKeyDown={
                                  editMode && worker.active !== false && date <= attendanceToday()
                                    ? (e) => {
                                        const setStatus = (val: string) => {
                                          e.preventDefault();
                                          const key = `${worker.id}|${date}`;
                                          const newP = { ...pending, [key]: val };
                                          setPending(newP);
                                          flushPending(newP);
                                        };
                                        if (e.key === "p" || e.key === "P") setStatus("Present");
                                        else if (e.key === "a" || e.key === "A") setStatus("Absent");
                                        else if (e.key === "l" || e.key === "L") setStatus("Leave");
                                        else if (e.key === "h" || e.key === "H") setStatus("Half Day");
                                        else if (e.key === "Delete" || e.key === "Backspace") setStatus("");
                                        else if (e.key === " " || e.key === "Enter") {
                                          e.preventDefault();
                                          cycleCell(worker.id, date, status);
                                        }
                                      }
                                    : undefined
                                }
                              />
                            </div>
                          </td>
                        );
                      })}

                      {/* Present count */}
                      <td className="border-r border-slate-100 px-2 py-2 text-center font-bold tabular-nums text-emerald-700 dark:border-[#253651] dark:text-emerald-400">
                        {worker.presentCount}
                      </td>
                      {/* Absent count */}
                      <td className="border-r border-slate-100 px-2 py-2 text-center font-bold tabular-nums text-red-500 dark:border-[#253651] dark:text-red-400">
                        {worker.absentCount}
                      </td>
                      {/* Attendance % */}
                      <td
                        className={cn(
                          "px-2 py-2 text-center font-bold tabular-nums",
                          worker.attendancePct === null
                            ? "text-muted-foreground"
                            : worker.attendancePct >= 90
                              ? "text-emerald-700 dark:text-emerald-400"
                              : worker.attendancePct >= 75
                                ? "text-amber-600 dark:text-amber-400"
                                : "text-red-500 dark:text-red-400"
                        )}
                      >
                        {worker.attendancePct !== null ? `${worker.attendancePct}%` : "—"}
                      </td>
                    </tr>
                  ))}

                  {/* ── Daily summary row ────────────────────────────────────── */}
                  <tr className="sticky bottom-0 border-t-2 border-blue-200 bg-blue-50 font-semibold dark:border-blue-900/70 dark:bg-[#183050] print:bg-gray-100">
                    <td className="px-2 py-2 border-r sticky left-0 bg-blue-50 dark:bg-[#183050] z-10 text-muted-foreground text-[11px] print:bg-gray-100" />
                    <td className="px-3 py-2 border-r sticky left-[88px] bg-blue-50 dark:bg-[#183050] z-10 text-muted-foreground text-[11px] whitespace-nowrap print:bg-gray-100">
                      Daily Total
                    </td>
                    {data.dates.map(({ date }) => {
                      const ds = data.dailySummary[date] || { present: 0, absent: 0 };
                      return (
                        <td key={date} className="text-center px-0 py-2 border-r w-8 align-top">
                          {ds.present > 0 && (
                            <div className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-400 leading-tight">
                              {ds.present}
                            </div>
                          )}
                          {ds.absent > 0 && (
                            <div className="text-[11px] font-semibold text-red-500 dark:text-red-400 leading-tight">
                              {ds.absent}
                            </div>
                          )}
                          {ds.present === 0 && ds.absent === 0 && (
                            <span className="text-muted-foreground/30 text-[11px]">—</span>
                          )}
                        </td>
                      );
                    })}
                    <td className="border-r" />
                    <td className="border-r" />
                    <td className="text-center px-2 py-2 text-muted-foreground">
                      {overallPct !== null ? `${overallPct}%` : "—"}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {/* ── Legend ──────────────────────────────────────────────────────── */}
          <AttendanceLegend />
        </>
      )}
    </div>
  );
}
