import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/PageHeader";
import { Loader2, CalendarDays, Printer, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { fmtCurrency } from "./factoryworkerattendancereport/utils";
import { StatusPill } from "./factoryworkerattendancereport/components/StatusPill";
import { AttendanceSummaryCards } from "./factoryworkerattendancereport/components/AttendanceSummaryCards";
import { AttendanceLegend } from "./factoryworkerattendancereport/components/AttendanceLegend";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import { useFactoryWorkerAttendanceReportState } from "./useFactoryWorkerAttendanceReportState";
import {
  FactoryWorkerAttendanceReportSection,
  FactoryWorkerAttendanceReportSection2,
} from "./FactoryWorkerAttendanceReportSection";

export default function FactoryWorkerAttendanceReport() {
  const {
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
  } = useFactoryWorkerAttendanceReportState();

  return (
    <div className="flex flex-col gap-5 rounded-2xl bg-gradient-to-b from-blue-50/50 via-background to-background px-2 pb-4 text-foreground dark:from-[hsl(var(--factory-hue)_59%_11%)] dark:via-[hsl(var(--factory-hue)_49%_8%)] dark:to-[hsl(var(--factory-hue)_49%_8%)] sm:px-4 sm:py-4 print:gap-3 print:rounded-none print:bg-white print:p-0 print:text-black">
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
            className="gap-2 rounded-lg border border-blue-500 bg-blue-600 px-5 font-semibold text-white shadow-[0_5px_15px_hsl(var(--factory-hue)_83%_53%_/_0.25)] hover:bg-blue-700 hover:text-white dark:border-blue-400 dark:bg-blue-600 dark:hover:bg-blue-500 print:hidden"
          >
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
        </div>
      </div>

      {/* ── Date mode selector ──────────────────────────────────────────────── */}
      <FactoryWorkerAttendanceReportSection2
        customEnd={customEnd}
        customStart={customStart}
        mode={mode}
        navigateMonth={navigateMonth}
        rangeLabel={rangeLabel}
        setCustomEnd={setCustomEnd}
        setCustomStart={setCustomStart}
        setMode={setMode}
      />

      {/* ── Filter + toggle bar ─────────────────────────────────────────────── */}
      <FactoryWorkerAttendanceReportSection
        absentCount={absentCount}
        data={data}
        editMode={editMode}
        filter={filter}
        fullyAbsentCount={fullyAbsentCount}
        hideFullAbsent={hideFullAbsent}
        presentCount={presentCount}
        recordChanges={recordChanges}
        saveMutation={saveMutation}
        setEditMode={setEditMode}
        setFilter={setFilter}
        setHideFullAbsent={setHideFullAbsent}
        sortedWorkers={sortedWorkers}
      />

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
            <div className="overflow-auto rounded-2xl border border-slate-200 bg-white shadow-[0_10px_30px_rgba(15,23,42,0.06)] dark:border-blue-900/70 dark:bg-[hsl(var(--factory-hue)_56%_11%)] dark:shadow-[0_16px_32px_rgba(0,0,0,0.2)] print:max-h-none print:overflow-visible print:rounded-none print:border-0 print:bg-white print:shadow-none">
              <table className="w-full text-xs border-collapse min-w-max print:text-[11px]">
                <thead>
                  <tr className="bg-slate-100 text-slate-700 dark:bg-[hsl(var(--factory-hue)_52%_19%)] dark:text-slate-200 print:bg-gray-100 print:text-black">
                    <th className="sticky left-0 top-0 z-30 min-w-[88px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-left font-semibold dark:border-[hsl(var(--factory-hue)_38%_27%)] dark:bg-[hsl(var(--factory-hue)_52%_19%)] print:bg-gray-100">
                      Code
                    </th>
                    <th className="sticky left-[88px] top-0 z-30 min-w-[160px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-3 py-3 text-left font-semibold dark:border-[hsl(var(--factory-hue)_38%_27%)] dark:bg-[hsl(var(--factory-hue)_52%_19%)] print:bg-gray-100">
                      Worker
                    </th>
                    {data.dates.map(({ date, label, abbr, isWeekend }) => (
                      <th
                        key={date}
                        className={cn(
                          "sticky top-0 z-20 w-8 min-w-[32px] border-b border-r border-slate-200 px-0 py-2 text-center font-semibold dark:border-[hsl(var(--factory-hue)_38%_27%)]",
                          isWeekend
                            ? "bg-amber-50/80 text-amber-600 dark:bg-[#3d301f] dark:text-amber-300"
                            : "bg-slate-100 dark:bg-[hsl(var(--factory-hue)_52%_19%)]"
                        )}
                      >
                        <div className="flex flex-col items-center gap-0 leading-tight">
                          <span className="text-[11px] text-muted-foreground font-normal">{abbr}</span>
                          <span className="text-[11px] font-semibold">{label}</span>
                        </div>
                      </th>
                    ))}
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold text-emerald-700 dark:border-[hsl(var(--factory-hue)_38%_27%)] dark:bg-[hsl(var(--factory-hue)_52%_19%)] dark:text-emerald-300 print:bg-gray-100">
                      P
                    </th>
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-r border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold text-red-500 dark:border-[hsl(var(--factory-hue)_38%_27%)] dark:bg-[hsl(var(--factory-hue)_52%_19%)] dark:text-red-400 print:bg-gray-100">
                      A
                    </th>
                    <th className="sticky top-0 z-20 min-w-[52px] whitespace-nowrap border-b border-slate-200 bg-slate-100 px-2 py-3 text-center font-bold dark:border-[hsl(var(--factory-hue)_38%_27%)] dark:bg-[hsl(var(--factory-hue)_52%_19%)] print:bg-gray-100">
                      %
                    </th>
                  </tr>
                </thead>

                <tbody>
                  {filteredWorkers.map((worker, idx) => (
                    <tr
                      key={worker.id}
                      className={cn(
                        "border-b border-slate-100 transition-colors hover:bg-blue-50/70 dark:border-[hsl(var(--factory-hue)_37%_23%)] dark:hover:bg-[hsl(var(--factory-hue)_54%_22%)]",
                        idx % 2 === 0
                          ? "bg-white dark:bg-[hsl(var(--factory-hue)_56%_11%)]"
                          : "bg-slate-50/70 dark:bg-[hsl(var(--factory-hue)_52%_13%)]"
                      )}
                      data-testid={`row-worker-${worker.id}`}
                    >
                      <td
                        className={cn(
                          "sticky left-0 z-10 border-r border-slate-100 px-3 py-2 font-mono text-muted-foreground dark:border-[hsl(var(--factory-hue)_37%_23%)]",
                          idx % 2 === 0
                            ? "bg-white dark:bg-[hsl(var(--factory-hue)_56%_11%)]"
                            : "bg-slate-50/70 dark:bg-[hsl(var(--factory-hue)_52%_13%)]"
                        )}
                      >
                        {worker.employeeCode || "—"}
                      </td>
                      <td
                        className={cn(
                          "sticky left-[88px] z-10 whitespace-nowrap border-r border-slate-100 px-3 py-2 font-semibold dark:border-[hsl(var(--factory-hue)_37%_23%)]",
                          idx % 2 === 0
                            ? "bg-white dark:bg-[hsl(var(--factory-hue)_56%_11%)]"
                            : "bg-slate-50/70 dark:bg-[hsl(var(--factory-hue)_52%_13%)]"
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
                              "w-8 border-r border-slate-100 px-0 py-2 text-center dark:border-[hsl(var(--factory-hue)_37%_23%)]",
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
                      <td className="border-r border-slate-100 px-2 py-2 text-center font-bold tabular-nums text-emerald-700 dark:border-[hsl(var(--factory-hue)_37%_23%)] dark:text-emerald-400">
                        {worker.presentCount}
                      </td>
                      {/* Absent count */}
                      <td className="border-r border-slate-100 px-2 py-2 text-center font-bold tabular-nums text-red-500 dark:border-[hsl(var(--factory-hue)_37%_23%)] dark:text-red-400">
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
                  <tr className="sticky bottom-0 border-t-2 border-blue-200 bg-blue-50 font-semibold dark:border-blue-900/70 dark:bg-[hsl(var(--factory-hue)_54%_20%)] print:bg-gray-100">
                    <td className="px-2 py-2 border-r sticky left-0 bg-blue-50 dark:bg-[hsl(var(--factory-hue)_54%_20%)] z-10 text-muted-foreground text-[11px] print:bg-gray-100" />
                    <td className="px-3 py-2 border-r sticky left-[88px] bg-blue-50 dark:bg-[hsl(var(--factory-hue)_54%_20%)] z-10 text-muted-foreground text-[11px] whitespace-nowrap print:bg-gray-100">
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
