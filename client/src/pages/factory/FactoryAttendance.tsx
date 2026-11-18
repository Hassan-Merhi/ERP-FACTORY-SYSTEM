import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PeriodFilter } from "@/components/ui/period-filter";
import { Label } from "@/components/ui/label";
import { CalendarDays, Save, FileDown, Loader2, MessageCircle } from "lucide-react";
import { formatDate } from "./factoryattendance/utils";
import { PerWorkerView } from "./factoryattendance/components/PerWorkerView";
import { AttendanceActionsMenu } from "./factoryattendance/components/AttendanceActionsMenu";
import { AttendanceSummaryGrid } from "./factoryattendance/components/AttendanceSummaryGrid";
import { AttendanceReportImage } from "./factoryattendance/components/AttendanceReportImage";
import { LanguageChoiceDialog } from "./factoryattendance/components/LanguageChoiceDialog";
import { AttendanceAdminApprovalDialog } from "./factoryattendance/components/AttendanceAdminApprovalDialog";
import { attendanceToday } from "./factoryattendance/attendanceEditPolicy";
import "./factoryTrackingModern.css";
import "./factoryAttendanceRefresh.css";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { useFactoryAttendanceState } from "./useFactoryAttendanceStatePart2";
import { FactoryAttendanceCardSection } from "./FactoryAttendanceCardSection";

export default function FactoryAttendance() {
  const {
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    attendanceMap,
    attendancePct,
    attendanceReportRef,
    attendanceWaGroupId,
    canEditPastWithoutPassword,
    counts,
    handlePrintWithLang,
    handleRangeExport,
    handleSave,
    isExportingRange,
    isLoading,
    markAll,
    mode,
    notesMap,
    printDialog,
    rangeEnd,
    rangeInvalid,
    rangePrintDialog,
    rangeStart,
    recordChanges,
    reportAbsentWorkers,
    reset,
    saveMutation,
    selectedDate,
    sendWhatsappImageMutation,
    setApprovalOpen,
    setNotes,
    setPrintDialog,
    setRangeEnd,
    setRangePrintDialog,
    setRangeStart,
    setSelectedDate,
    setStatus,
    setStatusFilter,
    setWorkerSearch,
    showDailyAttendance,
    statusFilter,
    visibleWorkers,
    workerSearch,
    workers,
  } = useFactoryAttendanceState();

  return (
    <div className="factory-tracking-modern factory-tracking-attendance factory-attendance-refresh">
      <div className="space-y-4">
        {/* Workers hub "Attendance" tab: the Payroll hub PageHeader titles the page; keep the date context only. */}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="rounded-full bg-background/50 px-2.5 py-1 text-[11px] font-medium">
            {formatDate(selectedDate)}
          </Badge>
          {selectedDate < attendanceToday() && !canEditPastWithoutPassword([selectedDate]) && (
            <Badge variant="secondary" className="rounded-full">
              Earlier date — Admin approval required to save
            </Badge>
          )}
        </div>

        {mode === "perWorker" ? (
          <div className="space-y-3">
            <Button variant="outline" size="sm" className="rounded-xl" onClick={showDailyAttendance}>
              <CalendarDays className="mr-1.5 h-4 w-4" />
              Back to Attendance
            </Button>
            <PerWorkerView />
          </div>
        ) : (
          <>
            {/* Attendance controls + range export */}
            <Card className="attendance-command-card overflow-hidden border-border/70 bg-card/75 shadow-none">
              <CardContent className="p-4">
                <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(500px,0.9fr)] xl:gap-0">
                  <div className="space-y-3 xl:pr-5">
                    <div className="flex items-center gap-2">
                      <div className="grid h-8 w-8 place-items-center rounded-lg bg-muted/50 text-muted-foreground">
                        <CalendarDays className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">Attendance Controls</p>
                        <p className="text-xs text-muted-foreground">Choose the date and manage the register.</p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <Label htmlFor="attendance-date" className="text-xs text-muted-foreground">
                          Attendance Date
                        </Label>
                        <Input
                          id="attendance-date"
                          data-testid="input-attendance-date"
                          type="date"
                          max={attendanceToday()}
                          value={selectedDate}
                          onChange={(e) => setSelectedDate(e.target.value)}
                          className="w-44 rounded-xl bg-background/70"
                        />
                      </div>

                      <Button
                        variant="outline"
                        size="default"
                        onClick={() => sendWhatsappImageMutation.mutate()}
                        disabled={
                          !attendanceWaGroupId || !workers.length || isLoading || sendWhatsappImageMutation.isPending
                        }
                        data-testid="button-send-attendance-whatsapp-image"
                        className="rounded-xl"
                      >
                        {sendWhatsappImageMutation.isPending ? (
                          <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                        ) : (
                          <MessageCircle className="mr-1.5 h-4 w-4" />
                        )}
                        {sendWhatsappImageMutation.isPending ? "Sending…" : "Send WhatsApp Image"}
                      </Button>

                      <AttendanceActionsMenu
                        disabled={!workers.length}
                        canChange={recordChanges.allowed}
                        onMarkAll={markAll}
                        onReset={reset}
                        onPrint={setPrintDialog}
                      />

                      <Button
                        size="default"
                        className="rounded-xl shadow-xs"
                        data-testid="button-save-attendance"
                        onClick={handleSave}
                        disabled={
                          !workers.length ||
                          saveMutation.isPending ||
                          selectedDate > attendanceToday() ||
                          !recordChanges.allowed
                        }
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
                  </div>

                  <div className="space-y-3 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                    <div className="flex items-center gap-2">
                      <div className="grid h-8 w-8 place-items-center rounded-lg bg-muted/50 text-muted-foreground">
                        <FileDown className="h-4 w-4" />
                      </div>
                      <div>
                        <p className="text-sm font-semibold">Range Export</p>
                        <p className="text-xs text-muted-foreground">
                          Export or print attendance across any date range.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-wrap items-end gap-2">
                      <div className="space-y-1">
                        <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          Period
                        </Label>
                        <PeriodFilter
                          value={{
                            fromDate: rangeStart,
                            toDate: rangeEnd,
                            preset: rangeStart || rangeEnd ? "custom" : "all_time",
                          }}
                          requireBoundedRange
                          onChange={(v) => {
                            setRangeStart(v.fromDate);
                            setRangeEnd(v.toDate);
                          }}
                          data-testid="attendance-range-period"
                        />
                      </div>
                      <ExportButton
                        size="default"
                        data-testid="button-range-export-excel"
                        onClick={() => setRangePrintDialog("excel")}
                        disabled={!rangeStart || !rangeEnd || rangeInvalid}
                        busy={isExportingRange}
                        className="rounded-xl"
                      />
                      <ExportButton
                        kind="print"
                        size="default"
                        data-testid="button-range-print"
                        onClick={() => setRangePrintDialog("print")}
                        disabled={!rangeStart || !rangeEnd || rangeInvalid || isExportingRange}
                        className="rounded-xl"
                      />
                    </div>
                    {rangeInvalid && (
                      <p className="text-xs font-medium text-destructive">From date cannot be after To date.</p>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Summary Cards */}
            {workers.length > 0 && <AttendanceSummaryGrid counts={counts} />}

            {/* Attendance Table */}
            <FactoryAttendanceCardSection
              attendanceMap={attendanceMap}
              attendancePct={attendancePct}
              counts={counts}
              handleSave={handleSave}
              isLoading={isLoading}
              notesMap={notesMap}
              recordChanges={recordChanges}
              saveMutation={saveMutation}
              selectedDate={selectedDate}
              setNotes={setNotes}
              setStatus={setStatus}
              setStatusFilter={setStatusFilter}
              setWorkerSearch={setWorkerSearch}
              statusFilter={statusFilter}
              visibleWorkers={visibleWorkers}
              workerSearch={workerSearch}
              workers={workers}
            />
          </>
        )}

        <AttendanceAdminApprovalDialog
          open={approvalOpen}
          onOpenChange={setApprovalOpen}
          onApprove={approveAttendanceSave}
          isPending={saveMutation.isPending}
          dates={approvalDates}
        />
        <AttendanceReportImage
          ref={attendanceReportRef}
          selectedDate={selectedDate}
          counts={counts}
          attendancePct={attendancePct}
          reportAbsentWorkers={reportAbsentWorkers}
          notesMap={notesMap}
        />

        <LanguageChoiceDialog
          open={printDialog !== null}
          onClose={() => setPrintDialog(null)}
          testId="dialog-print-language"
          buttonTestIdPrefix="button-print"
          isExport={Boolean(printDialog?.startsWith("excel"))}
          onChoose={handlePrintWithLang}
        />

        <LanguageChoiceDialog
          open={rangePrintDialog !== null}
          onClose={() => setRangePrintDialog(null)}
          testId="dialog-range-language"
          buttonTestIdPrefix="button-range"
          isExport={rangePrintDialog === "excel"}
          onChoose={(lang) => handleRangeExport(lang, rangePrintDialog!)}
        />
      </div>
    </div>
  );
}
