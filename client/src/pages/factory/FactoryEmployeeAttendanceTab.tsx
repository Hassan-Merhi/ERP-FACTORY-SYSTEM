import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import {
  CalendarDays,
  CheckCircle,
  XCircle,
  RotateCcw,
  Save,
  Users,
  UserCheck,
  UserX,
  Clock,
  User,
} from "lucide-react";
import {
  STATUS_COLORS,
  STATUS_OPTIONS,
  SummaryCard,
  formatDate,
  useFactoryEmployeeAttendanceTabState,
  type AttendanceStatus,
} from "./useFactoryEmployeeAttendanceTabState";
import { PerEmployeeView } from "./PerEmployeeView";
import { EmptyState, ErrorState } from "@/components/ui/page-state";

export default function FactoryEmployeeAttendanceTab() {
  const {
    data,
    refetch,
    isError,
    canEditPastWithoutPassword,
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    attendanceMap,
    counts,
    emps,
    handleSave,
    isLoading,
    markAll,
    mode,
    notesMap,
    recordChanges,
    reset,
    saveMutation,
    selectedCompany,
    selectedDate,
    setApprovalOpen,
    setAttendanceMap,
    setMode,
    setNotesMap,
    setSelectedDate,
    setShift,
    shift,
  } = useFactoryEmployeeAttendanceTabState();

  return (
    <div className="space-y-5 rounded-2xl border border-slate-200/70 bg-gradient-to-b from-slate-50/80 to-white p-3 shadow-sm sm:p-5 dark:border-blue-400/10 dark:from-[hsl(var(--factory-hue)_62%_12%)] dark:via-[hsl(var(--factory-hue)_60%_12%)] dark:to-[hsl(var(--factory-hue)_59%_10%)]">
      <div className="inline-flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white/80 p-1.5 shadow-sm dark:border-blue-400/20 dark:bg-slate-900/70">
        <Button
          variant={mode === "daily" ? "default" : "outline"}
          className={
            mode === "daily"
              ? "rounded-lg border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700"
              : "rounded-lg border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }
          onClick={() => setMode("daily")}
          data-testid="button-mode-daily"
        >
          <CalendarDays className="h-4 w-4 mr-2" />
          Daily View
        </Button>
        <Button
          variant={mode === "perEmployee" ? "default" : "outline"}
          className={
            mode === "perEmployee"
              ? "rounded-lg border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700"
              : "rounded-lg border-transparent text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-slate-800"
          }
          onClick={() => setMode("perEmployee")}
          data-testid="button-mode-per-employee"
        >
          <User className="h-4 w-4 mr-2" />
          Per Employee
        </Button>
      </div>

      {mode === "perEmployee" ? (
        <PerEmployeeView key={selectedCompany?.id ?? "no-company"} />
      ) : (
        <>
          <Card className="rounded-2xl border-slate-200/90 bg-white/90 shadow-sm dark:border-blue-400/25 dark:bg-[hsl(var(--factory-hue)_53%_16%)]/80">
            <CardContent className="px-4 py-4 sm:px-5 sm:py-5">
              <div className="flex flex-wrap items-end gap-3 sm:gap-4">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Attendance Date</Label>
                  <Input
                    type="date"
                    max={attendanceToday()}
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="h-10 w-44 rounded-xl border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-950/40"
                    data-testid="input-attendance-date"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground">Shift (optional)</Label>
                  <Input
                    placeholder="e.g. Morning"
                    value={shift}
                    onChange={(e) => setShift(e.target.value)}
                    className="h-10 w-40 rounded-xl border-slate-300 bg-white dark:border-slate-600 dark:bg-slate-950/40"
                    data-testid="input-shift"
                  />
                </div>
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    className="rounded-xl border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 dark:border-emerald-500/60 dark:bg-emerald-500/15 dark:text-emerald-200 dark:hover:bg-emerald-500/25"
                    onClick={() => markAll("Present")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-present"
                  >
                    <UserCheck className="h-4 w-4 mr-1" /> Mark All Present
                  </Button>
                  <Button
                    variant="outline"
                    className="rounded-xl border-rose-300 bg-rose-50 text-rose-800 hover:bg-rose-100 dark:border-rose-500/60 dark:bg-rose-500/15 dark:text-rose-200 dark:hover:bg-rose-500/25"
                    onClick={() => markAll("Absent")}
                    disabled={!emps.length}
                    data-testid="button-mark-all-absent"
                  >
                    <UserX className="h-4 w-4 mr-1" /> Mark All Absent
                  </Button>
                  <Button
                    variant="ghost"
                    className="rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 dark:border-slate-600 dark:bg-slate-800/60 dark:hover:bg-slate-700"
                    onClick={reset}
                    disabled={!emps.length}
                    data-testid="button-reset"
                  >
                    <RotateCcw className="h-4 w-4 mr-1" /> Reset
                  </Button>
                  {recordChanges.allowed && (
                    <Button
                      className="rounded-xl border border-blue-500 bg-gradient-to-r from-sky-500 to-blue-600 px-5 text-white shadow-md shadow-blue-500/20 hover:from-sky-600 hover:to-blue-700"
                      onClick={handleSave}
                      disabled={!emps.length || saveMutation.isPending || selectedDate > attendanceToday()}
                      data-testid="button-save-attendance"
                    >
                      <Save className="h-4 w-4 mr-1" />
                      {saveMutation.isPending ? "Saving…" : "Save Attendance"}
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>

          {emps.length > 0 && (
            <div className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
              <SummaryCard
                icon={<Users className="h-5 w-5" />}
                label="Total"
                value={counts.total}
                color="text-blue-800 dark:text-blue-100"
                testId="stat-total"
              />
              <SummaryCard
                icon={<CheckCircle className="h-5 w-5" />}
                label="Present"
                value={counts.present}
                color="text-green-600 dark:text-green-400"
                testId="stat-present"
              />
              <SummaryCard
                icon={<XCircle className="h-5 w-5" />}
                label="Absent"
                value={counts.absent}
                color="text-red-600 dark:text-red-400"
                testId="stat-absent"
              />
              <SummaryCard
                icon={<Clock className="h-5 w-5" />}
                label="Other"
                value={counts.other}
                color="text-amber-600 dark:text-amber-400"
                testId="stat-other"
              />
            </div>
          )}

          <Card className="overflow-hidden rounded-2xl border-slate-200/90 bg-white/95 shadow-sm dark:border-blue-400/25 dark:bg-[hsl(var(--factory-hue)_53%_16%)]/80">
            <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 px-4 pb-3 pt-5 sm:px-5">
              <CardTitle className="flex flex-wrap items-center gap-2 text-base font-semibold sm:text-lg">
                <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-200">
                  <CalendarDays className="h-5 w-5" />
                </span>
                Employees — {formatDate(selectedDate)}
                {shift && <Badge variant="secondary">{shift}</Badge>}
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
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-8">
                            #
                          </th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">
                            Employee
                          </th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">
                            Department
                          </th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200 w-44">
                            Status
                          </th>
                          <th className="text-left px-4 py-3 font-semibold text-slate-600 dark:text-slate-200">
                            Notes
                          </th>
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
                                  onValueChange={(v) =>
                                    setAttendanceMap((p) => ({ ...p, [emp.id]: v as AttendanceStatus }))
                                  }
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
                            <SelectTrigger
                              className={`h-10 rounded-lg text-sm font-semibold ${STATUS_COLORS[status] ?? ""}`}
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
        </>
      )}
      {selectedDate < attendanceToday() && !canEditPastWithoutPassword && (
        <Badge variant="secondary">Earlier date — Admin approval required to save</Badge>
      )}
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
