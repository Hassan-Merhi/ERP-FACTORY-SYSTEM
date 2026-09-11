import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";
import {
  CalendarDays,
  CheckCircle,
  XCircle,
  RotateCcw,
  Save,
  Printer,
  FileDown,
  Users,
  UserCheck,
  UserX,
  Clock,
  Languages,
  ChevronDown,
} from "lucide-react";

import type {
  AttendanceBulkRecord,
  AttendanceRecord,
  AttendanceStatus,
  ViewMode,
  WorkerRow,
} from "./factoryattendance/types";
import {
  STATUS_COLORS,
  STATUS_OPTIONS,
  exportRangeExcel,
  exportWeeklyExcel,
  formatDate,
  generateDateRange,
  generateRangePrintHtml,
  generateWeeklyBlankSheetHtml,
  generateWeeklyResultsSheetHtml,
  getInitialMode,
  getWeekDays,
  setModeInUrl,
  todayStr,
} from "./factoryattendance/utils";
import { PerWorkerView } from "./factoryattendance/components/PerWorkerView";
import { SummaryCard } from "./factoryattendance/components/SummaryCard";
export default function FactoryAttendance() {
  const { toast } = useToast();
  const [mode, setMode] = useState<ViewMode>(getInitialMode);

  const handleSetMode = (m: ViewMode) => {
    setMode(m);
    setModeInUrl(m);
  };

  // ── Daily view state ──────────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<string>(todayStr());
  const [shift, setShift] = useState<string>("");

  // ── Range export state ────────────────────────────────────────
  const [rangeStart, setRangeStart] = useState<string>(todayStr());
  const [rangeEnd, setRangeEnd] = useState<string>(todayStr());
  const [isExportingRange, setIsExportingRange] = useState(false);
  const [rangePrintDialog, setRangePrintDialog] = useState<"excel" | "print" | null>(null);
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});

  const { data, isLoading } = useQuery<{ workers: WorkerRow[]; attendance: AttendanceRecord[] }>({
    queryKey: ["/api/factory/attendance", selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/factory/attendance?date=${selectedDate}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch attendance");
      return res.json();
    },
  });

  useEffect(() => {
    if (!data) return;
    const newMap: Record<number, AttendanceStatus> = {};
    const newNotes: Record<number, string> = {};
    for (const w of data.workers) {
      newMap[w.id] = "Present";
    }
    for (const a of data.attendance) {
      newMap[a.workerId] = a.status as AttendanceStatus;
      newNotes[a.workerId] = a.notes || "";
    }
    setAttendanceMap(newMap);
    setNotesMap(newNotes);
  }, [data]);

  const saveMutation = useMutation({
    mutationFn: (records: AttendanceBulkRecord[]) => apiRequest("POST", "/api/factory/attendance/bulk", { records }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/attendance", selectedDate] });
      toast({ title: "Attendance saved", description: `Saved for ${selectedDate}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = useCallback(() => {
    if (!data?.workers.length) return;
    const records = data.workers.map((w) => ({
      workerId: w.id,
      attendanceDate: selectedDate,
      shift: shift || undefined,
      status: attendanceMap[w.id] ?? "Present",
      notes: notesMap[w.id] || undefined,
    }));
    saveMutation.mutate(records);
  }, [data, selectedDate, shift, attendanceMap, notesMap, saveMutation]);

  const markAll = (status: AttendanceStatus) => {
    if (!data?.workers) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const w of data.workers) next[w.id] = status;
    setAttendanceMap(next);
  };

  const reset = () => {
    if (!data?.workers) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const w of data.workers) next[w.id] = "Present";
    setAttendanceMap(next);
    setNotesMap({});
  };

  const setStatus = (workerId: number, status: AttendanceStatus) => {
    setAttendanceMap((prev) => ({ ...prev, [workerId]: status }));
  };

  const setNotes = (workerId: number, notes: string) => {
    setNotesMap((prev) => ({ ...prev, [workerId]: notes }));
  };

  const handleRangeExport = async (lang: "en" | "ar", mode: "excel" | "print") => {
    if (!rangeStart || !rangeEnd) return;
    setIsExportingRange(true);
    setRangePrintDialog(null);
    try {
      const res = await fetch(`/api/factory/attendance/range?startDate=${rangeStart}&endDate=${rangeEnd}`, {
        credentials: "include",
      });
      if (!res.ok) throw new Error("Failed to fetch range data");
      const { workers: rangeWorkers, attendance: rangeAttendance } = await res.json();
      const dates = generateDateRange(rangeStart, rangeEnd);
      if (mode === "excel") {
        exportRangeExcel(rangeWorkers, rangeAttendance, dates, rangeStart, rangeEnd, lang);
      } else {
        // Print should only show active workers — inactive ones have no records
        // and would incorrectly default to "Present" for every day.
        const activeOnly = (rangeWorkers as WorkerRow[]).filter((w) => w.active !== false);
        const html = generateRangePrintHtml(activeOnly, rangeAttendance, dates, rangeStart, rangeEnd, lang);
        openPrintWindow(html);
      }
    } catch (err) {
      toast({ title: "Export failed", description: getErrorDetails(err).message, variant: "destructive" });
    } finally {
      setIsExportingRange(false);
    }
  };

  const [printDialog, setPrintDialog] = useState<"blank" | "results" | "excel-blank" | "excel-results" | null>(null);

  const openPrintWindow = (html: string) => {
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.write(html);
    w.document.close();
    w.focus();
    setTimeout(() => w.print(), 400);
  };

  const handlePrintWithLang = (lang: "en" | "ar") => {
    const weekDays = getWeekDays(selectedDate);
    if (printDialog === "blank") {
      // Print only active workers — inactive ones should not appear
      const html = generateWeeklyBlankSheetHtml(workers, weekDays, shift, lang);
      openPrintWindow(html);
    } else if (printDialog === "results") {
      const html = generateWeeklyResultsSheetHtml(
        workers, // active workers only
        attendanceMap,
        notesMap,
        weekDays,
        selectedDate,
        shift,
        lang
      );
      openPrintWindow(html);
    } else if (printDialog === "excel-blank") {
      exportWeeklyExcel(data?.workers ?? [], weekDays, shift, lang, "blank", {}, {}, selectedDate);
    } else if (printDialog === "excel-results") {
      exportWeeklyExcel(data?.workers ?? [], weekDays, shift, lang, "results", attendanceMap, notesMap, selectedDate);
    }
    // Note: data?.workers now contains all workers (active + inactive);
    // exportWeeklyExcel splits them into two sheets internally.
    setPrintDialog(null);
  };

  // All workers (active + inactive) — used only by the Excel export
  const allWorkers = data?.workers ?? [];
  // UI only shows active workers in the attendance grid, sorted by employee code (HMD001, HMD002…)
  const workers = [...allWorkers.filter((w) => w.active !== false)].sort((a, b) => {
    const codeA = a.employeeCode ?? "";
    const codeB = b.employeeCode ?? "";
    if (!codeA && !codeB) return a.fullName.localeCompare(b.fullName);
    if (!codeA) return 1;
    if (!codeB) return -1;
    // Extract trailing numeric portion for natural sort (HMD001 < HMD002 < HMD010)
    const numA = parseInt(codeA.replace(/\D/g, ""), 10) || 0;
    const numB = parseInt(codeB.replace(/\D/g, ""), 10) || 0;
    if (numA !== numB) return numA - numB;
    return codeA.localeCompare(codeB);
  });

  const counts = {
    total: workers.length,
    present: workers.filter((w) => (attendanceMap[w.id] ?? "Present") === "Present").length,
    absent: workers.filter((w) => attendanceMap[w.id] === "Absent").length,
    other: workers.filter((w) => {
      const s = attendanceMap[w.id] ?? "Present";
      return s !== "Present" && s !== "Absent";
    }).length,
  };

  return (
    <div className="space-y-4 p-1">
      {/* Mode toggle */}
      <div className="flex gap-2">
        <Button
          variant={mode === "daily" ? "default" : "outline"}
          size="default"
          data-testid="button-mode-daily"
          onClick={() => handleSetMode("daily")}
        >
          <CalendarDays className="h-4 w-4 mr-2" />
          Daily View
        </Button>
      </div>

      {mode === "perWorker" ? (
        <PerWorkerView />
      ) : (
        <>
          {/* Filters + Actions */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="attendance-date" className="text-xs text-muted-foreground">
                    Attendance Date
                  </Label>
                  <Input
                    id="attendance-date"
                    data-testid="input-attendance-date"
                    type="date"
                    value={selectedDate}
                    onChange={(e) => setSelectedDate(e.target.value)}
                    className="w-44"
                  />
                </div>
                <div className="flex flex-col gap-1">
                  <Label htmlFor="shift-input" className="text-xs text-muted-foreground">
                    Shift (optional)
                  </Label>
                  <Input
                    id="shift-input"
                    data-testid="input-shift"
                    placeholder="e.g. Morning"
                    value={shift}
                    onChange={(e) => setShift(e.target.value)}
                    className="w-36"
                    dir="auto"
                  />
                </div>

                <div className="flex gap-2 ml-auto items-center">
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="outline"
                        size="default"
                        data-testid="button-actions-dropdown"
                        disabled={!workers.length}
                      >
                        Actions
                        <ChevronDown className="h-4 w-4 ml-1" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-52">
                      <DropdownMenuItem data-testid="menu-mark-all-present" onClick={() => markAll("Present")}>
                        <UserCheck className="h-4 w-4 mr-2" />
                        Mark All Present
                      </DropdownMenuItem>
                      <DropdownMenuItem data-testid="menu-mark-all-absent" onClick={() => markAll("Absent")}>
                        <UserX className="h-4 w-4 mr-2" />
                        Mark All Absent
                      </DropdownMenuItem>
                      <DropdownMenuItem data-testid="menu-reset" onClick={reset}>
                        <RotateCcw className="h-4 w-4 mr-2" />
                        Reset
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem data-testid="menu-print-blank" onClick={() => setPrintDialog("blank")}>
                        <Printer className="h-4 w-4 mr-2" />
                        Print Blank Sheet
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        data-testid="menu-export-excel-blank"
                        onClick={() => setPrintDialog("excel-blank")}
                      >
                        <FileDown className="h-4 w-4 mr-2" />
                        Blank Excel
                      </DropdownMenuItem>
                      <DropdownMenuItem data-testid="menu-export-pdf" onClick={() => setPrintDialog("results")}>
                        <Printer className="h-4 w-4 mr-2" />
                        Export PDF
                      </DropdownMenuItem>
                      <DropdownMenuItem data-testid="menu-export-excel" onClick={() => setPrintDialog("excel-results")}>
                        <FileDown className="h-4 w-4 mr-2" />
                        Export Excel
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                  <Button
                    size="default"
                    data-testid="button-save-attendance"
                    onClick={handleSave}
                    disabled={!workers.length || saveMutation.isPending}
                  >
                    <Save className="h-4 w-4 mr-1" />
                    {saveMutation.isPending ? "Saving…" : "Save Attendance"}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Range Export Card */}
          <Card>
            <CardContent className="pt-4">
              <div className="flex flex-wrap gap-3 items-end">
                <div className="flex flex-col gap-1">
                  <Label className="text-xs text-muted-foreground font-medium">Range Export</Label>
                  <div className="flex items-center gap-2 flex-wrap">
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="date"
                        data-testid="input-range-start"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        className="w-40"
                      />
                    </div>
                    <div className="flex flex-col gap-1">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="date"
                        data-testid="input-range-end"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        className="w-40"
                      />
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 items-center flex-wrap ml-auto">
                  <Button
                    variant="outline"
                    size="default"
                    data-testid="button-range-export-excel"
                    onClick={() => setRangePrintDialog("excel")}
                    disabled={!rangeStart || !rangeEnd || isExportingRange}
                  >
                    <FileDown className="h-4 w-4 mr-1" />
                    {isExportingRange ? "Exporting…" : "Export Range Excel"}
                  </Button>
                  <Button
                    variant="outline"
                    size="default"
                    data-testid="button-range-print"
                    onClick={() => setRangePrintDialog("print")}
                    disabled={!rangeStart || !rangeEnd || isExportingRange}
                  >
                    <Printer className="h-4 w-4 mr-1" />
                    Print Range
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary Cards */}
          {workers.length > 0 && (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <SummaryCard
                icon={<Users className="h-4 w-4" />}
                label="Total"
                value={counts.total}
                color="text-foreground"
                testId="stat-total"
              />
              <SummaryCard
                icon={<CheckCircle className="h-4 w-4" />}
                label="Present"
                value={counts.present}
                color="text-green-600 dark:text-green-400"
                testId="stat-present"
              />
              <SummaryCard
                icon={<XCircle className="h-4 w-4" />}
                label="Absent"
                value={counts.absent}
                color="text-red-600 dark:text-red-400"
                testId="stat-absent"
              />
              <SummaryCard
                icon={<Clock className="h-4 w-4" />}
                label="Other"
                value={counts.other}
                color="text-amber-600 dark:text-amber-400"
                testId="stat-other"
              />
            </div>
          )}

          {/* Attendance Table */}
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base flex items-center gap-2">
                <CalendarDays className="h-4 w-4" />
                Workers — {formatDate(selectedDate)}
                {shift && <Badge variant="secondary">{shift}</Badge>}
              </CardTitle>
              {workers.length > 0 && (
                <span className="text-sm text-muted-foreground">
                  {workers.length} worker{workers.length !== 1 ? "s" : ""}
                </span>
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
                <div className="text-center text-muted-foreground py-12 text-sm">
                  No active workers found for this company.
                </div>
              ) : (
                <>
                  {/* Desktop table */}
                  <div className="hidden sm:block overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-30 bg-muted/50">
                        <tr className="border-b bg-muted/40">
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-8">#</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-24">Code</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">Worker Name</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground w-44">Status</th>
                          <th className="text-left px-4 py-2 font-medium text-muted-foreground">Notes</th>
                        </tr>
                      </thead>
                      <tbody>
                        {workers.map((worker, idx) => {
                          const status = attendanceMap[worker.id] ?? "Present";
                          return (
                            <tr
                              key={worker.id}
                              data-testid={`row-worker-${worker.id}`}
                              className="border-b last:border-0 hover-elevate"
                            >
                              <td className="px-4 py-2 text-muted-foreground">{idx + 1}</td>
                              <td
                                className="px-4 py-2 font-mono text-xs text-muted-foreground"
                                data-testid={`text-worker-code-${worker.id}`}
                              >
                                {worker.employeeCode ?? "—"}
                              </td>
                              <td
                                className="px-4 py-2 font-medium"
                                dir="auto"
                                data-testid={`text-worker-name-${worker.id}`}
                              >
                                {worker.fullName}
                              </td>
                              <td className="px-4 py-2">
                                <Select
                                  value={status}
                                  onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}
                                >
                                  <SelectTrigger
                                    data-testid={`select-status-${worker.id}`}
                                    className={`h-8 text-xs font-medium ${STATUS_COLORS[status] ?? ""}`}
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
                                  className="h-8 text-xs"
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
                  <div className="sm:hidden space-y-2 p-3">
                    {workers.map((worker, idx) => {
                      const status = attendanceMap[worker.id] ?? "Present";
                      return (
                        <div
                          key={worker.id}
                          data-testid={`card-worker-${worker.id}`}
                          className="border rounded-md p-3 space-y-2"
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
                              {worker.employeeCode && (
                                <span
                                  className="text-xs font-mono text-muted-foreground"
                                  data-testid={`text-worker-code-mobile-${worker.id}`}
                                >
                                  {worker.employeeCode}
                                </span>
                              )}
                            </div>
                            <span className="text-xs text-muted-foreground shrink-0">{idx + 1}</span>
                          </div>
                          <Select value={status} onValueChange={(v) => setStatus(worker.id, v as AttendanceStatus)}>
                            <SelectTrigger
                              data-testid={`select-status-mobile-${worker.id}`}
                              className={`h-9 text-sm font-medium ${STATUS_COLORS[status] ?? ""}`}
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
                            className="h-8 text-xs"
                            dir="auto"
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

      <Dialog
        open={printDialog !== null}
        onOpenChange={(open) => {
          if (!open) setPrintDialog(null);
        }}
      >
        <DialogContent className="max-w-xs" data-testid="dialog-print-language">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Languages className="h-4 w-4" />
              {printDialog?.startsWith("excel") ? "Choose Export Language" : "Choose Print Language"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button onClick={() => handlePrintWithLang("en")} data-testid="button-print-english">
              English
            </Button>
            <Button
              variant="outline"
              onClick={() => handlePrintWithLang("ar")}
              data-testid="button-print-arabic"
              dir="rtl"
            >
              العربية
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={rangePrintDialog !== null}
        onOpenChange={(open) => {
          if (!open) setRangePrintDialog(null);
        }}
      >
        <DialogContent className="max-w-xs" data-testid="dialog-range-language">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Languages className="h-4 w-4" />
              {rangePrintDialog === "excel" ? "Choose Export Language" : "Choose Print Language"}
            </DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 pt-2">
            <Button onClick={() => handleRangeExport("en", rangePrintDialog!)} data-testid="button-range-english">
              English
            </Button>
            <Button
              variant="outline"
              onClick={() => handleRangeExport("ar", rangePrintDialog!)}
              data-testid="button-range-arabic"
              dir="rtl"
            >
              العربية
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Per Worker View ────────────────────────────────────────────────────────────
