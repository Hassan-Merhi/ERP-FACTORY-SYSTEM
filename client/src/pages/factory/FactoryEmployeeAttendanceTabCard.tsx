// Extracted from ./FactoryEmployeeAttendanceTab.tsx
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarDays, User } from "lucide-react";
import {
  STATUS_COLORS,
  STATUS_OPTIONS,
  formatDate,
  useFactoryEmployeeAttendanceTabState,
  type AttendanceStatus,
} from "./useFactoryEmployeeAttendanceTabState";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export function FactoryEmployeeAttendanceTabCard({
  attendanceMap,
  data,
  emps,
  isError,
  isLoading,
  notesMap,
  refetch,
  selectedDate,
  setAttendanceMap,
  setNotesMap,
}: Pick<
  ReturnType<typeof useFactoryEmployeeAttendanceTabState>,
  | "attendanceMap"
  | "data"
  | "emps"
  | "isError"
  | "isLoading"
  | "notesMap"
  | "refetch"
  | "selectedDate"
  | "setAttendanceMap"
  | "setNotesMap"
>) {
  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200/90 bg-white/95 shadow-sm dark:border-blue-400/25 dark:bg-[hsl(var(--factory-hue)_53%_16%)]/80">
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-5 sm:px-5">
        <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold sm:text-lg">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200">
            <CalendarDays className="h-5 w-5" />
          </span>
          Employees — {formatDate(selectedDate)}
        </CardTitle>
        {emps.length > 0 && (
          <span className="text-sm text-muted-foreground">
            {emps.length} employee{emps.length !== 1 ? "s" : ""}
          </span>
        )}
      </CardHeader>
      <CardContent className="px-3 pb-4 pt-0 sm:px-5 sm:pb-5">
        {isLoading ? (
          <div className="p-4 space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-md" />
            ))}
          </div>
        ) : isError && !data ? (
          <ErrorState onAction={() => void refetch()} actionLabel="Try again" />
        ) : emps.length === 0 ? (
          <EmptyState icon={User} title="No active employees found." />
        ) : (
          <>
            <div className="hidden overflow-x-auto rounded-xl border border-slate-200 sm:block dark:border-slate-600/70">
              <table className="w-full min-w-[760px] text-sm">
                <thead className="sticky top-0 z-30">
                  <tr className="border-b border-slate-200 bg-slate-100/90 dark:border-slate-600 dark:bg-[hsl(var(--factory-hue)_43%_23%)]">
                    <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-8">#</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Employee</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Department</th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-44">
                      Status
                    </th>
                    <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {emps.map((emp, idx) => {
                    const status = attendanceMap[emp.id] ?? "Present";
                    return (
                      <tr
                        key={emp.id}
                        className="border-b border-slate-100 transition-colors last:border-0 hover:bg-blue-50/60 dark:border-slate-700/70 dark:hover:bg-blue-400/10"
                        data-testid={`row-employee-${emp.id}`}
                      >
                        <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                        <td className="px-4 py-2 font-medium" data-testid={`text-employee-name-${emp.id}`}>
                          {emp.firstName} {emp.lastName}
                          {emp.code && <span className="text-xs text-muted-foreground ml-1">({emp.code})</span>}
                        </td>
                        <td className="px-4 py-2 text-sm text-muted-foreground">{emp.department || "—"}</td>
                        <td className="px-4 py-2">
                          <Select
                            value={status}
                            onValueChange={(v) => setAttendanceMap((p) => ({ ...p, [emp.id]: v as AttendanceStatus }))}
                          >
                            <SelectTrigger
                              data-testid={`select-status-${emp.id}`}
                              className={`h-9 rounded-lg text-xs font-semibold shadow-sm ${STATUS_COLORS[status] ?? ""}`}
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
                            placeholder="Optional notes"
                            value={notesMap[emp.id] ?? ""}
                            onChange={(e) => setNotesMap((p) => ({ ...p, [emp.id]: e.target.value }))}
                            className="h-9 rounded-lg border-slate-200 bg-slate-50/70 text-xs dark:border-slate-600 dark:bg-slate-950/30"
                            data-testid={`input-notes-${emp.id}`}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="space-y-3 sm:hidden">
              {emps.map((emp, idx) => {
                const status = attendanceMap[emp.id] ?? "Present";
                return (
                  <div
                    key={emp.id}
                    className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4 shadow-sm dark:border-slate-600/70 dark:bg-slate-900/50"
                    data-testid={`card-employee-${emp.id}`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <p className="font-medium text-sm">
                        {emp.firstName} {emp.lastName}
                      </p>
                      <span className="text-xs text-muted-foreground shrink-0">{idx + 1}</span>
                    </div>
                    <Select
                      value={status}
                      onValueChange={(v) => setAttendanceMap((p) => ({ ...p, [emp.id]: v as AttendanceStatus }))}
                    >
                      <SelectTrigger className={`h-10 rounded-lg text-sm font-semibold ${STATUS_COLORS[status] ?? ""}`}>
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
                      placeholder="Notes (optional)"
                      value={notesMap[emp.id] ?? ""}
                      onChange={(e) => setNotesMap((p) => ({ ...p, [emp.id]: e.target.value }))}
                      className="h-8 text-xs"
                    />
                  </div>
                );
              })}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
