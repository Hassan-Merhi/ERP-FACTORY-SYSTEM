// Extracted from ./FactoryAttendance.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, Loader2, Save, Search } from "lucide-react";
import type { AttendanceStatus } from "./factoryattendance/types";
import { formatDate, STATUS_COLORS, STATUS_OPTIONS } from "./factoryattendance/utils";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import { useFactoryAttendanceState } from "./useFactoryAttendanceStatePart2";
import { SearchField } from "@/components/ui/search-field";

export function FactoryAttendanceCardSection({
  attendanceMap,
  attendancePct,
  counts,
  handleSave,
  isLoading,
  notesMap,
  recordChanges,
  saveMutation,
  selectedDate,
  setNotes,
  setStatus,
  setStatusFilter,
  setWorkerSearch,
  statusFilter,
  visibleWorkers,
  workerSearch,
  workers,
}: Pick<
  ReturnType<typeof useFactoryAttendanceState>,
  | "attendanceMap"
  | "attendancePct"
  | "counts"
  | "handleSave"
  | "isLoading"
  | "notesMap"
  | "recordChanges"
  | "saveMutation"
  | "selectedDate"
  | "setNotes"
  | "setStatus"
  | "setStatusFilter"
  | "setWorkerSearch"
  | "statusFilter"
  | "visibleWorkers"
  | "workerSearch"
  | "workers"
>) {
  return (
    <Card className="attendance-register overflow-hidden border-border/70 bg-card/75 shadow-none">
      <CardHeader className="attendance-register-header gap-3 border-b border-border/60 bg-muted/15 px-4 py-4 sm:px-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="h-4 w-4 text-primary" />
              Workers
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">{formatDate(selectedDate)}</p>
          </div>
          {workers.length > 0 && (
            <div className="flex items-center gap-3">
              <div className="hidden text-right sm:block">
                <p className="text-sm font-semibold tabular-nums">{attendancePct}%</p>
                <p className="text-[11px] text-muted-foreground">present today</p>
              </div>
              <Badge variant="outline" className="rounded-full bg-background/60 px-3 py-1">
                {workers.length} worker{workers.length !== 1 ? "s" : ""}
              </Badge>
            </div>
          )}
        </div>

        {workers.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <SearchField
              value={workerSearch}
              onValueChange={setWorkerSearch}
              placeholder="Search worker, code, position…"
              wrapperClassName="w-full sm:max-w-sm"
              className="h-9 rounded-xl bg-background/70"
              data-testid="input-attendance-worker-search"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as typeof statusFilter)}>
                <SelectTrigger
                  className="h-9 w-[145px] rounded-xl bg-background/70"
                  data-testid="select-attendance-status-filter"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All statuses</SelectItem>
                  <SelectItem value="present">Present</SelectItem>
                  <SelectItem value="absent">Absent</SelectItem>
                  <SelectItem value="other">Other</SelectItem>
                </SelectContent>
              </Select>
              <span className="text-[11px] text-muted-foreground">
                Showing {visibleWorkers.length} of {workers.length}
              </span>
            </div>
          </div>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : workers.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            No active workers found for this company.
          </div>
        ) : visibleWorkers.length === 0 ? (
          <div className="flex flex-col items-center justify-center px-4 py-12 text-center">
            <Search className="mb-2 h-5 w-5 text-muted-foreground" />
            <p className="text-sm font-medium">No workers match these filters</p>
            <Button
              variant="ghost"
              size="sm"
              className="mt-2 rounded-xl"
              onClick={() => {
                setWorkerSearch("");
                setStatusFilter("all");
              }}
            >
              Clear filters
            </Button>
          </div>
        ) : (
          <>
            {/* Desktop table */}
            <div className="attendance-table-scroll hidden overflow-x-auto sm:block">
              <table className="attendance-table w-full text-sm">
                <thead className="sticky top-0 z-30 bg-muted">
                  <tr className="border-b border-border/60">
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Code</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Worker Name</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground w-44">Status</th>
                    <th className="text-left px-4 py-2 font-medium text-muted-foreground">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWorkers.map((worker) => {
                    const idx = workers.findIndex((item) => item.id === worker.id);
                    const status = attendanceMap[worker.id] ?? "Present";
                    return (
                      <tr
                        key={worker.id}
                        data-testid={`row-worker-${worker.id}`}
                        className="attendance-table-row border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20"
                      >
                        <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                        <td
                          className="attendance-worker-code px-4 py-2 font-mono text-xs text-muted-foreground"
                          data-testid={`text-worker-code-${worker.id}`}
                        >
                          {worker.employeeCode ?? "—"}
                        </td>
                        <td className="px-4 py-2" dir="auto">
                          <div
                            className="attendance-worker-name font-medium"
                            data-testid={`text-worker-name-${worker.id}`}
                          >
                            {worker.fullName}
                          </div>
                          {(worker.position || worker.department) && (
                            <div className="attendance-worker-position mt-0.5 text-[11px] text-muted-foreground">
                              {worker.position || worker.department}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Select value={status} onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}>
                            <SelectTrigger
                              data-testid={`select-status-${worker.id}`}
                              data-attendance-status={status}
                              className={`attendance-status-trigger h-9 rounded-lg bg-background/70 text-xs font-medium ${STATUS_COLORS[status] ?? ""}`}
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {STATUS_OPTIONS.map((s) => (
                                <SelectItem key={s} value={s}>
                                  {s}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </td>
                        <td className="px-4 py-2">
                          <Input
                            data-testid={`input-notes-${worker.id}`}
                            placeholder="Optional notes"
                            value={notesMap[worker.id] ?? ""}
                            onChange={(e) => setNotes(worker.id, e.target.value)}
                            className="attendance-notes-input h-9 rounded-lg bg-background/70 text-xs"
                            dir="auto"
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Mobile cards */}
            <div className="space-y-2.5 p-3 sm:hidden">
              {visibleWorkers.map((worker) => {
                const idx = workers.findIndex((item) => item.id === worker.id);
                const status = attendanceMap[worker.id] ?? "Present";
                return (
                  <div
                    key={worker.id}
                    data-testid={`card-worker-${worker.id}`}
                    className="attendance-worker-mobile space-y-3 rounded-xl border border-border/70 bg-background/40 p-3.5 shadow-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p
                          className="font-medium text-sm"
                          dir="auto"
                          data-testid={`text-worker-name-mobile-${worker.id}`}
                        >
                          {worker.fullName}
                        </p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                          {worker.employeeCode && (
                            <span className="font-mono" data-testid={`text-worker-code-mobile-${worker.id}`}>
                              {worker.employeeCode}
                            </span>
                          )}
                          {(worker.position || worker.department) && (
                            <span>{worker.position || worker.department}</span>
                          )}
                        </div>
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">{idx + 1}</span>
                    </div>
                    <Select value={status} onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}>
                      <SelectTrigger
                        data-testid={`select-status-mobile-${worker.id}`}
                        data-attendance-status={status}
                        className={`attendance-status-trigger h-10 rounded-lg bg-background/70 text-sm font-medium ${STATUS_COLORS[status] ?? ""}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {STATUS_OPTIONS.map((s) => (
                          <SelectItem key={s} value={s}>
                            {s}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      data-testid={`input-notes-mobile-${worker.id}`}
                      placeholder="Notes (optional)"
                      value={notesMap[worker.id] ?? ""}
                      onChange={(e) => setNotes(worker.id, e.target.value)}
                      className="attendance-notes-input h-9 rounded-lg bg-background/70 text-xs"
                      dir="auto"
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}

        {workers.length > 0 && (
          <div className="attendance-save-bar sticky bottom-0 z-20 flex flex-col gap-2 border-t border-border/70 bg-background/95 px-4 py-3 backdrop-blur-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <span>
                <strong className="text-foreground">{counts.present}</strong> present
              </span>
              <span>
                <strong className="text-foreground">{counts.absent}</strong> absent
              </span>
              {counts.other > 0 && (
                <span>
                  <strong className="text-foreground">{counts.other}</strong> other
                </span>
              )}
              <span>{attendancePct}% attendance</span>
            </div>
            <Button
              size="sm"
              className="rounded-xl shadow-xs sm:min-w-36"
              data-testid="button-save-attendance-sticky"
              onClick={handleSave}
              disabled={saveMutation.isPending || selectedDate > attendanceToday() || !recordChanges.allowed}
              title={recordChanges.reason ?? undefined}
            >
              {saveMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <Save className="mr-1.5 h-4 w-4" />
              )}
              {saveMutation.isPending ? "Saving…" : "Save Attendance"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
