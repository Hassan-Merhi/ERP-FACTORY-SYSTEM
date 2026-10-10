import { useState, useMemo, useCallback, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, CalendarDays, Printer, ChevronLeft, ChevronRight, Pencil, EyeOff, Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";

import type {
  AttendanceFilter,
  AttendanceReportData,
  DateMode,
  WorkerReportRow,
} from "./factoryworkerattendancereport/types";
import {
  CYCLE,
  MONTH_NAMES,
  computeWorkerExpectedSalary,
  fmtCurrency,
  isoMonthEnd,
  isoMonthStart,
  isoToday,
  isoYesterday,
  workerCodeNum,
} from "./factoryworkerattendancereport/utils";
import { StatusPill } from "./factoryworkerattendancereport/components/StatusPill";
export default function FactoryWorkerAttendanceReport() {
  const qc = useQueryClient();

  /* Date mode state */
  const [mode, setMode] = useState<DateMode>("today");
  /* customStart/customEnd are used for both "thisMonth" navigation and "custom" range */
  const [customStart, setCustomStart] = useState(isoMonthStart);
  const [customEnd, setCustomEnd] = useState(isoMonthEnd);

  /* UI state */
  const [filter, setFilter] = useState<AttendanceFilter>("all");
  const [hideFullAbsent, setHideFullAbsent] = useState(false);
  const [editMode, setEditMode] = useState(false);

  /* Pending optimistic edits: "workerId|date" → status */
  const [pending, setPending] = useState<Record<string, string | undefined>>({});
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

  const queryKey = ["/api/factory/workers/attendance-report", startDate, endDate];

  const { data, isLoading, isError, error, refetch } = useQuery<AttendanceReportData>({
    queryKey,
    queryFn: async () => {
      const res = await fetch(`/api/factory/workers/attendance-report?startDate=${startDate}&endDate=${endDate}`, {
        credentials: "include",
      });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    retry: 1,
  });

  /* Mutation: save single cell */
  const saveMutation = useMutation({
    mutationFn: async (records: Array<{ workerId: number; attendanceDate: string; status: string }>) => {
      const validRecords = records.filter((r) => r.status !== "");
      const blankRecords = records.filter((r) => r.status === "");
      const promises = [];
      if (validRecords.length > 0) {
        promises.push(
          apiRequest("POST", "/api/factory/attendance/bulk", {
            records: validRecords.map((r) => ({
              workerId: r.workerId,
              attendanceDate: r.attendanceDate,
              status: r.status,
            })),
          })
        );
      }
      if (blankRecords.length > 0) {
        for (const r of blankRecords) {
          promises.push(
            fetch(`/api/factory/attendance/clear`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              credentials: "include",
              body: JSON.stringify({ workerId: r.workerId, attendanceDate: r.attendanceDate }),
            }).catch(() => {})
          );
        }
      }
      await Promise.all(promises);
    },
    onSuccess: () => {
      setPending({});
      qc.invalidateQueries({ queryKey });
    },
    onError: () => {
      setPending({});
      qc.invalidateQueries({ queryKey });
    },
  });

  /* Batch-save pending edits after short debounce */
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
        saveMutation.mutate(records);
      }, 800);
    },
    [saveMutation]
  );

  const cycleCell = useCallback(
    (workerId: number, date: string, currentStatus?: string) => {
      const key = `${workerId}|${date}`;
      const next = CYCLE[currentStatus ?? ""] ?? "Present";
      const newPending = { ...pending, [key]: next };
      setPending(newPending);
      flushPending(newPending);
    },
    [pending, flushPending]
  );

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

  /* Salary KPIs — computed from currently filtered workers */
  const salaryKpi = useMemo(() => {
    if (!data || !data.dates.length) return null;
    let totalExpected = 0;
    let totalPaid = 0;
    for (const w of filteredWorkers) {
      totalExpected += computeWorkerExpectedSalary(w, data.dates);
      totalPaid += parseFloat(w.paidSalary || "0");
    }
    return { totalExpected, totalPaid, totalRemaining: totalExpected - totalPaid };
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
    <div className="flex flex-col gap-4">
      {/* ── Header bar ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <CalendarDays className="h-5 w-5 text-muted-foreground" />
          <h2 className="text-lg font-semibold">Attendance Report</h2>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Button
            variant="outline"
            size="default"
            onClick={() => window.print()}
            data-testid="button-print-report"
            className="print:hidden"
          >
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
        </div>
      </div>

      {/* ── Date mode selector ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 flex-wrap print:hidden">
        <span className="text-xs text-muted-foreground font-medium">Period:</span>
        <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
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
              className={cn("h-7 px-3 text-xs rounded-xs", mode === m ? "bg-muted font-semibold" : "")}
            >
              {m === "today" ? "Today" : m === "yesterday" ? "Yesterday" : m === "thisMonth" ? "This Month" : "Custom"}
            </Button>
          ))}
        </div>

        {/* Month navigator for thisMonth */}
        {mode === "thisMonth" && (
          <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
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
      <div className="flex items-center gap-2 flex-wrap print:hidden">
        <span className="text-xs text-muted-foreground font-medium">Show:</span>
        <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("all")}
            data-testid="filter-all"
            className={cn("h-7 px-3 text-xs rounded-xs", filter === "all" ? "bg-muted font-semibold" : "")}
          >
            All
            {data && (
              <Badge variant="secondary" className="ml-1.5 text-[10px] px-1.5 py-0 h-4">
                {sortedWorkers.length}
              </Badge>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("present")}
            data-testid="filter-present"
            className={cn("h-7 px-3 text-xs rounded-xs", filter === "present" ? "status-success font-semibold" : "")}
          >
            No Absences
            {data && (
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0 h-4 status-success">
                {presentCount}
              </Badge>
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setFilter("absent")}
            data-testid="filter-absent"
            className={cn("h-7 px-3 text-xs rounded-xs", filter === "absent" ? "status-danger font-semibold" : "")}
          >
            Has Absences
            {data && (
              <Badge variant="outline" className="ml-1.5 text-[10px] px-1.5 py-0 h-4 status-danger">
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
            className={cn("h-7 px-3 text-xs gap-1.5", hideFullAbsent ? "bg-muted font-semibold" : "")}
          >
            {hideFullAbsent ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
            {hideFullAbsent ? "Show" : "Hide"} fully absent
            <Badge
              variant="secondary"
              className="text-[10px] px-1.5 py-0 h-4 bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400"
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
          className={cn("h-7 px-3 text-xs gap-1.5", editMode ? "bg-muted font-semibold" : "")}
        >
          <Pencil className="h-3.5 w-3.5" />
          {editMode ? "Editing" : "Edit"}
          {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
        </Button>
      </div>

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
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground font-medium mb-1">Workers</p>
                <p className="text-2xl font-bold tabular-nums" data-testid="stat-total-workers">
                  {filteredWorkers.length}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground font-medium mb-1">Attendance Rate</p>
                <p
                  className={cn(
                    "text-2xl font-bold tabular-nums",
                    overallPct === null
                      ? "text-muted-foreground"
                      : overallPct >= 90
                        ? "text-emerald-600 dark:text-emerald-400"
                        : overallPct >= 75
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-red-500 dark:text-red-400"
                  )}
                  data-testid="stat-attendance-pct"
                >
                  {overallPct !== null ? `${overallPct}%` : "—"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground font-medium mb-1">Expected Salary</p>
                <p className="text-xl font-bold tabular-nums text-foreground" data-testid="stat-expected-salary">
                  {salaryKpi ? fmtCurrency(salaryKpi.totalExpected) : "—"}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground font-medium mb-1">Paid Salary</p>
                <p
                  className="text-xl font-bold tabular-nums text-emerald-600 dark:text-emerald-400"
                  data-testid="stat-paid-salary"
                >
                  {salaryKpi ? fmtCurrency(salaryKpi.totalPaid) : "—"}
                </p>
              </CardContent>
            </Card>
            <Card className="border-amber-300 dark:border-amber-700">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground font-medium mb-1">Remaining Salary</p>
                <p
                  className={cn(
                    "text-xl font-bold tabular-nums",
                    !salaryKpi
                      ? "text-muted-foreground"
                      : salaryKpi.totalRemaining < 0
                        ? "text-blue-600 dark:text-blue-400"
                        : salaryKpi.totalRemaining === 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-amber-600 dark:text-amber-400"
                  )}
                  data-testid="stat-remaining-salary"
                >
                  {salaryKpi
                    ? salaryKpi.totalRemaining < 0
                      ? `Overpaid ${fmtCurrency(Math.abs(salaryKpi.totalRemaining))}`
                      : fmtCurrency(salaryKpi.totalRemaining)
                    : "—"}
                </p>
                {salaryKpi && salaryKpi.totalRemaining < 0 && (
                  <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-0.5">Overpaid</p>
                )}
              </CardContent>
            </Card>
          </div>

          {/* ── Edit mode hint ───────────────────────────────────────────────── */}
          {editMode && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2 print:hidden">
              <Pencil className="h-3.5 w-3.5 shrink-0" />
              Click a cell to cycle: P → A → L → H → Clear. Or press{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[10px]">P</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[10px]">A</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[10px]">L</kbd>{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[10px]">H</kbd> when focused.{" "}
              <kbd className="mx-1 px-1 rounded-sm border text-[10px]">Del</kbd> clears.
            </div>
          )}

          {/* ── No workers state ────────────────────────────────────────────── */}
          {data.workers.length === 0 ? (
            <Card>
              <CardContent className="p-10 text-center text-muted-foreground">
                No active workers found. Add workers first from the Workers tab.
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
            <div className="overflow-auto rounded-md border print:overflow-visible print:border-0 max-h-[calc(100vh-360px)] print:max-h-none">
              <table className="w-full text-xs border-collapse min-w-max print:text-[9px]">
                <thead>
                  <tr className="bg-muted print:bg-gray-100">
                    <th className="text-left px-2 py-2 font-medium border-b border-r whitespace-nowrap sticky top-0 left-0 bg-muted z-30 min-w-[70px] print:bg-gray-100">
                      Code
                    </th>
                    <th className="text-left px-3 py-2 font-medium border-b border-r whitespace-nowrap sticky top-0 left-[70px] bg-muted z-30 min-w-[160px] print:bg-gray-100">
                      Worker
                    </th>
                    {data.dates.map(({ date, label, abbr, isWeekend }) => (
                      <th
                        key={date}
                        className={cn(
                          "text-center px-0 py-1 font-medium border-b border-r w-8 min-w-[32px] sticky top-0 z-20",
                          isWeekend
                            ? "text-amber-600 dark:text-amber-400 bg-amber-50/60 dark:bg-amber-900/10"
                            : "bg-muted"
                        )}
                      >
                        <div className="flex flex-col items-center gap-0 leading-tight">
                          <span className="text-[9px] text-muted-foreground font-normal">{abbr}</span>
                          <span className="text-[11px] font-semibold">{label}</span>
                        </div>
                      </th>
                    ))}
                    <th className="text-center px-2 py-2 font-medium border-b border-r whitespace-nowrap min-w-[52px] text-emerald-700 dark:text-emerald-400 sticky top-0 z-20 bg-muted print:bg-gray-100">
                      P
                    </th>
                    <th className="text-center px-2 py-2 font-medium border-b border-r whitespace-nowrap min-w-[52px] text-red-500 dark:text-red-400 sticky top-0 z-20 bg-muted print:bg-gray-100">
                      A
                    </th>
                    <th className="text-center px-2 py-2 font-medium border-b whitespace-nowrap min-w-[52px] sticky top-0 z-20 bg-muted print:bg-gray-100">
                      %
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filteredWorkers.map((worker, idx) => (
                    <tr
                      key={worker.id}
                      className={cn("border-b transition-colors", idx % 2 === 0 ? "bg-background" : "bg-muted/20")}
                      data-testid={`row-worker-${worker.id}`}
                    >
                      <td
                        className={cn(
                          "px-2 py-1.5 border-r sticky left-0 z-10 font-mono text-muted-foreground",
                          idx % 2 === 0 ? "bg-background" : "bg-muted/20"
                        )}
                      >
                        {worker.employeeCode || "—"}
                      </td>
                      <td
                        className={cn(
                          "px-3 py-1.5 border-r sticky left-[70px] z-10 font-medium whitespace-nowrap",
                          idx % 2 === 0 ? "bg-background" : "bg-muted/20"
                        )}
                      >
                        <span className="truncate block max-w-[180px]" title={worker.fullName}>
                          {worker.fullName}
                        </span>
                      </td>

                      {data.dates.map(({ date, isWeekend }) => {
                        const status = effectiveStatus(worker, date);
                        return (
                          <td
                            key={date}
                            className={cn(
                              "text-center px-0 py-1.5 border-r w-8",
                              isWeekend ? "bg-amber-50/40 dark:bg-amber-900/5" : ""
                            )}
                            data-testid={`cell-${worker.id}-${date}`}
                          >
                            <div className="flex items-center justify-center">
                              <StatusPill
                                status={status}
                                absentsOnly={filter === "absent"}
                                editable={editMode}
                                onClick={editMode ? () => cycleCell(worker.id, date, status) : undefined}
                                onKeyDown={
                                  editMode
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
                                        else if (e.key === "h" || e.key === "H") setStatus("HalfDay");
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
                      <td className="text-center px-2 py-1.5 border-r font-semibold tabular-nums text-emerald-700 dark:text-emerald-400">
                        {worker.presentCount}
                      </td>
                      {/* Absent count */}
                      <td className="text-center px-2 py-1.5 border-r font-semibold tabular-nums text-red-500 dark:text-red-400">
                        {worker.absentCount}
                      </td>
                      {/* Attendance % */}
                      <td
                        className={cn(
                          "text-center px-2 py-1.5 font-semibold tabular-nums",
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
                  <tr className="border-t-2 bg-muted/60 font-semibold sticky bottom-0 print:bg-gray-100">
                    <td className="px-2 py-2 border-r sticky left-0 bg-muted/60 z-10 text-muted-foreground text-[10px] print:bg-gray-100" />
                    <td className="px-3 py-2 border-r sticky left-[70px] bg-muted/60 z-10 text-muted-foreground text-[10px] whitespace-nowrap print:bg-gray-100">
                      Daily Total
                    </td>
                    {data.dates.map(({ date }) => {
                      const ds = data.dailySummary[date] || { present: 0, absent: 0 };
                      return (
                        <td key={date} className="text-center px-0 py-2 border-r w-8 align-top">
                          {ds.present > 0 && (
                            <div className="text-[9px] font-semibold text-emerald-700 dark:text-emerald-400 leading-tight">
                              {ds.present}
                            </div>
                          )}
                          {ds.absent > 0 && (
                            <div className="text-[9px] font-semibold text-red-500 dark:text-red-400 leading-tight">
                              {ds.absent}
                            </div>
                          )}
                          {ds.present === 0 && ds.absent === 0 && (
                            <span className="text-muted-foreground/30 text-[9px]">—</span>
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
          <div className="flex items-center gap-4 text-xs text-muted-foreground print:hidden">
            <span className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-xs bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[9px] font-bold">
                P
              </span>
              Present
            </span>
            <span className="flex items-center gap-1.5">
              <span className="inline-flex items-center justify-center w-4 h-4 rounded-xs bg-red-100 dark:bg-red-900/40 text-red-600 dark:text-red-400 text-[9px] font-bold">
                A
              </span>
              Absent
            </span>
            <span className="flex items-center gap-1.5">
              <span className="text-muted-foreground/40">—</span>
              Not recorded
            </span>
            <span className="flex items-center gap-1.5">
              <Badge
                variant="outline"
                className="text-[9px] text-amber-600 dark:text-amber-400 border-amber-300 px-1 py-0 h-auto"
              >
                Sa/Su
              </Badge>
              Weekend
            </span>
          </div>
        </>
      )}
    </div>
  );
}
