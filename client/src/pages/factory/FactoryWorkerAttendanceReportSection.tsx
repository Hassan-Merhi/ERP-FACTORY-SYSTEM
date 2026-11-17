// Extracted from ./FactoryWorkerAttendanceReport.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ChevronLeft, ChevronRight, Eye, EyeOff, Loader2, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import type { DateMode } from "./factoryworkerattendancereport/types";
import { isoMonthEnd, isoMonthStart } from "./factoryworkerattendancereport/utils";
import {
  useFactoryWorkerAttendanceReportStatePart1,
  useFactoryWorkerAttendanceReportStatePart2,
} from "./useFactoryWorkerAttendanceReportStatePart1";
import { PeriodFilter } from "@/components/ui/period-filter";

export function useFactoryWorkerAttendanceReportState() {
  const {
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
    flushPending,
    handleApprovalOpenChange,
    hideFullAbsent,
    isError,
    isLoading,
    mode,
    navigateMonth,
    pending,
    recordChanges,
    refetch,
    saveMutation,
    setCustomEnd,
    setCustomStart,
    setEditMode,
    setFilter,
    setHideFullAbsent,
    setMode,
    setPending,
  } = useFactoryWorkerAttendanceReportStatePart1();
  const {
    absentCount,
    filteredWorkers,
    fullyAbsentCount,
    overallPct,
    presentCount,
    rangeLabel,
    salaryKpi,
    sortedWorkers,
  } = useFactoryWorkerAttendanceReportStatePart2({ customEnd, customStart, data, filter, hideFullAbsent, mode });
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

export function FactoryWorkerAttendanceReportSection({
  absentCount,
  data,
  editMode,
  filter,
  fullyAbsentCount,
  hideFullAbsent,
  presentCount,
  recordChanges,
  saveMutation,
  setEditMode,
  setFilter,
  setHideFullAbsent,
  sortedWorkers,
}: Pick<
  ReturnType<typeof useFactoryWorkerAttendanceReportState>,
  | "absentCount"
  | "data"
  | "editMode"
  | "filter"
  | "fullyAbsentCount"
  | "hideFullAbsent"
  | "presentCount"
  | "recordChanges"
  | "saveMutation"
  | "setEditMode"
  | "setFilter"
  | "setHideFullAbsent"
  | "sortedWorkers"
>) {
  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <span className="text-sm font-semibold text-muted-foreground">Show:</span>
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]">
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
            "h-9 gap-1.5 rounded-lg border-slate-200 px-3 text-xs font-semibold dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]",
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
          "h-9 gap-1.5 rounded-lg border-slate-200 px-3 text-xs font-semibold dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]",
          editMode &&
            "border-blue-400 bg-blue-50 text-blue-700 dark:border-blue-500 dark:bg-blue-500/15 dark:text-blue-300"
        )}
      >
        <Pencil className="h-3.5 w-3.5" />
        {editMode ? "Editing" : "Edit"}
        {saveMutation.isPending && <Loader2 className="h-3 w-3 animate-spin ml-1" />}
      </Button>
    </div>
  );
}

export function FactoryWorkerAttendanceReportSection2({
  customEnd,
  customStart,
  mode,
  navigateMonth,
  rangeLabel,
  setCustomEnd,
  setCustomStart,
  setMode,
}: Pick<
  ReturnType<typeof useFactoryWorkerAttendanceReportState>,
  "customEnd" | "customStart" | "mode" | "navigateMonth" | "rangeLabel" | "setCustomEnd" | "setCustomStart" | "setMode"
>) {
  return (
    <div className="flex flex-wrap items-center gap-3 print:hidden">
      <span className="text-sm font-semibold text-muted-foreground">Period:</span>
      <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]">
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
                ? "bg-blue-600 text-white shadow-[0_2px_10px_hsl(var(--factory-hue)_83%_53%_/_0.35)] hover:bg-blue-700 hover:text-white dark:bg-blue-600 dark:hover:bg-blue-500"
                : "text-muted-foreground hover:bg-slate-100 dark:hover:bg-blue-950/70"
            )}
          >
            {m === "today" ? "Today" : m === "yesterday" ? "Yesterday" : m === "thisMonth" ? "This Month" : "Custom"}
          </Button>
        ))}
      </div>

      {/* Month navigator for thisMonth */}
      {mode === "thisMonth" && (
        <div className="flex flex-wrap items-center gap-1 rounded-xl border border-slate-200 bg-white/80 p-1 shadow-sm dark:border-blue-900/60 dark:bg-[hsl(var(--factory-hue)_51%_14%)]">
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
        <PeriodFilter
          value={{ fromDate: customStart, toDate: customEnd, preset: "custom" }}
          onChange={(v) => {
            setCustomStart(v.fromDate);
            setCustomEnd(v.toDate);
          }}
          requireBoundedRange
          data-testid="attendance-report-custom-period"
        />
      )}
    </div>
  );
}
