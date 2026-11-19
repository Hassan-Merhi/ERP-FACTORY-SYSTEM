import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { AttendanceActionsMenu } from "./factoryattendance/components/AttendanceActionsMenu";
import { AttendanceSheetPrintDialog } from "./people/AttendanceSheetPrintDialog";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import { CalendarDays, CheckCircle, XCircle, Save, Users, Clock, User } from "lucide-react";
import { SummaryCard, useFactoryEmployeeAttendanceTabState } from "./useFactoryEmployeeAttendanceTabState";
import { PerEmployeeView } from "./PerEmployeeView";
import { FactoryEmployeeAttendanceTabCard } from "./FactoryEmployeeAttendanceTabCard";

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
    printDialog,
    setPrintDialog,
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
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <AttendanceActionsMenu
                    disabled={!emps.length}
                    canChange={recordChanges.allowed}
                    onMarkAll={markAll}
                    onReset={reset}
                    onPrint={setPrintDialog}
                  />
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

          <FactoryEmployeeAttendanceTabCard
            attendanceMap={attendanceMap}
            data={data}
            emps={emps}
            isError={isError}
            isLoading={isLoading}
            notesMap={notesMap}
            refetch={refetch}
            selectedDate={selectedDate}
            setAttendanceMap={setAttendanceMap}
            setNotesMap={setNotesMap}
          />
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
      <AttendanceSheetPrintDialog
        kind={printDialog}
        onClose={() => setPrintDialog(null)}
        people={emps.map((e) => ({
          id: e.id,
          fullName: `${e.firstName} ${e.lastName}`,
          code: e.code,
          department: e.department,
        }))}
        attendanceMap={attendanceMap}
        notesMap={notesMap}
        selectedDate={selectedDate}
      />
    </div>
  );
}
