/**
 * PerWorkerView — extracted sub-component.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ErrorState } from "@/components/ui/page-state";
import { CalendarDays, CheckCircle, XCircle, User } from "lucide-react";

import { AttendanceAdminApprovalDialog } from "./AttendanceAdminApprovalDialog";
import { attendancePastDates } from "../attendanceEditPolicy";
import { generateDateRange } from "../utils";
import { SummaryCard } from "./SummaryCard";
import { usePerWorkerViewState } from "./usePerWorkerViewState";
import { PerWorkerViewCard } from "./PerWorkerViewCard";

export function PerWorkerView() {
  const {
    canEditPastWithoutPassword,
    recordChanges,
    setSelectedWorkerId,
    selectedWorkerId,
    workerComboOpen,
    setWorkerComboOpen,
    startDate,
    setStartDate,
    endDate,
    setEndDate,
    checkedDates,
    approvalOpen,
    setApprovalOpen,
    approvalDates,
    loadingWorkers,
    workersList,
    workerIdNum,
    loadingAttendance,
    attendanceError,
    attendanceRecords,
    refetchAttendance,
    dates,
    presentCount,
    absentCount,
    toggleDate,
    selectAll,
    deselectAll,
    saveMutation,
    handleSave,
    approveAttendanceSave,
    selectedWorker,
  } = usePerWorkerViewState();

  return (
    <div className="space-y-4">
      {/* Controls */}
      {attendancePastDates(generateDateRange(startDate, endDate)).length > 0 &&
        !canEditPastWithoutPassword(attendancePastDates(generateDateRange(startDate, endDate))) && (
          <Badge variant="secondary">Earlier dates require Admin approval to save</Badge>
        )}
      <PerWorkerViewCard
        dates={dates}
        deselectAll={deselectAll}
        endDate={endDate}
        handleSave={handleSave}
        loadingWorkers={loadingWorkers}
        recordChanges={recordChanges}
        saveMutation={saveMutation}
        selectAll={selectAll}
        selectedWorker={selectedWorker}
        selectedWorkerId={selectedWorkerId}
        setEndDate={setEndDate}
        setSelectedWorkerId={setSelectedWorkerId}
        setStartDate={setStartDate}
        setWorkerComboOpen={setWorkerComboOpen}
        startDate={startDate}
        workerComboOpen={workerComboOpen}
        workerIdNum={workerIdNum}
        workersList={workersList}
      />

      {/* Summary */}
      {workerIdNum && dates.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <SummaryCard
            icon={<CalendarDays className="h-4 w-4" />}
            label="Days in Range"
            value={dates.length}
            color="text-foreground"
            testId="stat-pw-total"
            modern
          />
          <SummaryCard
            icon={<CheckCircle className="h-4 w-4" />}
            label="Present"
            value={presentCount}
            color="text-green-600 dark:text-green-400"
            testId="stat-pw-present"
            modern
          />
          <SummaryCard
            icon={<XCircle className="h-4 w-4" />}
            label="Absent"
            value={absentCount}
            color="text-red-600 dark:text-red-400"
            testId="stat-pw-absent"
            modern
          />
        </div>
      )}

      {/* Date checkbox table */}
      <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
        <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 bg-muted/15 px-4 py-4 sm:px-5">
          <CardTitle className="flex items-center gap-2 text-base">
            <User className="h-4 w-4" />
            {selectedWorker ? selectedWorker.fullName : "Select a worker"}
            {selectedWorker?.employeeCode && <Badge variant="secondary">{selectedWorker.employeeCode}</Badge>}
          </CardTitle>
          {workerIdNum && dates.length > 0 && (
            <span className="text-sm text-muted-foreground">
              {startDate} to {endDate}
            </span>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {!workerIdNum ? (
            <div className="text-center text-muted-foreground py-12 text-sm">
              Select a worker above to mark their attendance.
            </div>
          ) : loadingAttendance ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full rounded-md" />
              ))}
            </div>
          ) : attendanceError && !attendanceRecords ? (
            <ErrorState
              onAction={() => void refetchAttendance()}
              actionLabel="Try again"
              className="rounded-none border-0 py-12"
            />
          ) : dates.length === 0 ? (
            <div className="text-center text-muted-foreground py-12 text-sm">No dates in the selected range.</div>
          ) : (
            <div className="table-responsive">
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted">
                  <tr className="border-b border-border/60">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Date</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Day</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-28">Present</th>
                  </tr>
                </thead>
                <tbody>
                  {dates.map((date, idx) => {
                    const dayName = new Date(date + "T00:00:00").toLocaleDateString(undefined, { weekday: "long" });
                    const isChecked = checkedDates[date] ?? false;
                    const isFriday = new Date(date + "T00:00:00").getDay() === 5;
                    const isSaturday = new Date(date + "T00:00:00").getDay() === 6;
                    const isSunday = new Date(date + "T00:00:00").getDay() === 0;
                    return (
                      <tr
                        key={date}
                        data-testid={`row-date-${date}`}
                        className={`cursor-pointer border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20 ${isFriday || isSaturday ? "bg-muted/15" : isSunday ? "bg-blue-50/30 dark:bg-blue-950/15" : ""}`}
                        onClick={() => toggleDate(date)}
                      >
                        <td className="px-4 py-3 text-muted-foreground">{idx + 1}</td>
                        <td className="px-4 py-3 font-medium">
                          {new Date(date + "T00:00:00").toLocaleDateString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                          })}
                        </td>
                        <td
                          className={`px-4 py-3 text-sm ${isFriday || isSaturday ? "text-muted-foreground italic" : isSunday ? "text-blue-600 dark:text-blue-400 font-medium" : "text-muted-foreground"}`}
                        >
                          {dayName}
                          {isSunday ? " *" : ""}
                        </td>
                        <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-2">
                            <Checkbox
                              data-testid={`checkbox-date-${date}`}
                              checked={isChecked}
                              onCheckedChange={() => toggleDate(date)}
                            />
                            <span
                              className={`text-xs font-medium ${isChecked ? "text-green-600 dark:text-green-400" : "text-red-500 dark:text-red-400"}`}
                            >
                              {isChecked ? "Present" : "Absent"}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
      <AttendanceAdminApprovalDialog
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        onApprove={approveAttendanceSave}
        isPending={saveMutation.isPending}
        dates={approvalDates}
      />
    </div>
  );
}

// ── Summary card ──────────────────────────────────────────────────────────────
