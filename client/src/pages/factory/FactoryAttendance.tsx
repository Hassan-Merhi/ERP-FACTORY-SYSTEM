import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useCallback, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
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
  Loader2,
  MessageCircle,
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
import "./factoryTrackingModern.css";

interface AttendanceWhatsappSettings {
  attendanceWhatsappGroupId?: string | null;
}

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
  const attendanceReportRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery<{ workers: WorkerRow[]; attendance: AttendanceRecord[] }>({
    queryKey: ["/api/factory/attendance", selectedDate],
    queryFn: async () => {
      const res = await fetch(`/api/factory/attendance?date=${selectedDate}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch attendance");
      return res.json();
    },
  });

  const { data: attendanceWhatsappSettings } = useQuery<AttendanceWhatsappSettings>({
    queryKey: ["/api/factory/settings?scope=attendance"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/factory/settings?scope=attendance");
      if (!res.ok) throw new Error("Failed to load Attendance WhatsApp settings");
      return res.json();
    },
    staleTime: 30_000,
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

  const attendanceWaGroupId = attendanceWhatsappSettings?.attendanceWhatsappGroupId ?? "";

  const sendWhatsappImageMutation = useMutation({
    mutationFn: async () => {
      if (!attendanceReportRef.current) throw new Error("Attendance image is not ready");

      const html2canvas = (await import("html2canvas")).default;
      const canvas = await html2canvas(attendanceReportRef.current, {
        backgroundColor: "#111315",
        scale: 2,
        logging: false,
      });

      const title = `Attendance Report — ${selectedDate}`;
      const res = await factoryApiRequest("POST", "/api/factory/send-mix-batch-image-whatsapp", {
        imageBase64: canvas.toDataURL("image/png"),
        date: selectedDate,
        fileName: `Attendance_${selectedDate}.png`,
        caption: title,
        reportLabel: title,
        destination: "attendance",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to send attendance image");
      }
      return res.json();
    },
    onSuccess: () => {
      toast({ title: "Attendance image sent to WhatsApp" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to send WhatsApp image", description: err.message, variant: "destructive" });
    },
  });

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

  const reportAbsentWorkers = workers
    .filter((worker) => attendanceMap[worker.id] === "Absent")
    .sort((a, b) => a.fullName.localeCompare(b.fullName, undefined, { sensitivity: "base", numeric: true }));
  const attendancePct = counts.total > 0 ? Math.round((counts.present / counts.total) * 100) : 0;

  return (
    <div className="factory-tracking-modern factory-tracking-attendance">
      <div className="space-y-4">
        <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-3">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-primary/20 bg-primary/10 text-primary shadow-sm">
                <CalendarDays className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-semibold tracking-tight">Attendance</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Record the day, review attendance at a glance, and send or export reports.
                </p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                variant={mode === "daily" ? "default" : "outline"}
                size="sm"
                className="h-8 rounded-full px-3"
                data-testid="button-mode-daily"
                onClick={() => handleSetMode("daily")}
              >
                <CalendarDays className="mr-1.5 h-3.5 w-3.5" />
                Daily View
              </Button>
              <Badge variant="outline" className="rounded-full bg-background/50 px-2.5 py-1 text-[11px] font-medium">
                {formatDate(selectedDate)}
              </Badge>
              {shift && (
                <Badge variant="secondary" className="rounded-full px-2.5 py-1 text-[11px] font-medium">
                  {shift}
                </Badge>
              )}
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2 xl:justify-end">
            <div className="space-y-1">
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
            <div className="space-y-1">
              <Label htmlFor="shift-input" className="text-xs text-muted-foreground">
                Shift (optional)
              </Label>
              <Input
                id="shift-input"
                data-testid="input-shift"
                placeholder="Optional"
                value={shift}
                onChange={(e) => setShift(e.target.value)}
                className="w-32"
                dir="auto"
              />
            </div>
            <Button
              variant="outline"
              size="default"
              onClick={() => sendWhatsappImageMutation.mutate()}
              disabled={!attendanceWaGroupId || !workers.length || isLoading || sendWhatsappImageMutation.isPending}
              data-testid="button-send-attendance-whatsapp-image"
            >
              {sendWhatsappImageMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <MessageCircle className="mr-1.5 h-4 w-4" />
              )}
              {sendWhatsappImageMutation.isPending ? "Sending…" : "Send WhatsApp Image"}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="default"
                  data-testid="button-actions-dropdown"
                  disabled={!workers.length}
                >
                  Actions
                  <ChevronDown className="ml-1 h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem data-testid="menu-mark-all-present" onClick={() => markAll("Present")}>
                  <UserCheck className="mr-2 h-4 w-4" />
                  Mark All Present
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="menu-mark-all-absent" onClick={() => markAll("Absent")}>
                  <UserX className="mr-2 h-4 w-4" />
                  Mark All Absent
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="menu-reset" onClick={reset}>
                  <RotateCcw className="mr-2 h-4 w-4" />
                  Reset
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem data-testid="menu-print-blank" onClick={() => setPrintDialog("blank")}>
                  <Printer className="mr-2 h-4 w-4" />
                  Print Blank Sheet
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="menu-export-excel-blank" onClick={() => setPrintDialog("excel-blank")}>
                  <FileDown className="mr-2 h-4 w-4" />
                  Blank Excel
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="menu-export-pdf" onClick={() => setPrintDialog("results")}>
                  <Printer className="mr-2 h-4 w-4" />
                  Export PDF
                </DropdownMenuItem>
                <DropdownMenuItem data-testid="menu-export-excel" onClick={() => setPrintDialog("excel-results")}>
                  <FileDown className="mr-2 h-4 w-4" />
                  Export Excel
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button
              size="default"
              className="shadow-sm"
              data-testid="button-save-attendance"
              onClick={handleSave}
              disabled={!workers.length || saveMutation.isPending}
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

        {mode === "perWorker" ? (
        <PerWorkerView />
      ) : (
        <>
          {/* Range Export Card */}
          <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
            <CardContent className="p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end">
                <div className="min-w-[180px] lg:mr-2">
                  <div className="flex items-center gap-2 text-sm font-semibold">
                    <div className="grid h-8 w-8 place-items-center rounded-lg bg-muted/50 text-muted-foreground">
                      <FileDown className="h-4 w-4" />
                    </div>
                    Range Export
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
                    Export or print attendance across any date range.
                  </p>
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">From</Label>
                    <Input
                      type="date"
                      data-testid="input-range-start"
                      value={rangeStart}
                      onChange={(e) => setRangeStart(e.target.value)}
                      className="w-40 rounded-xl bg-background/70"
                    />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">To</Label>
                    <Input
                      type="date"
                      data-testid="input-range-end"
                      value={rangeEnd}
                      onChange={(e) => setRangeEnd(e.target.value)}
                      className="w-40 rounded-xl bg-background/70"
                    />
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 lg:ml-auto">
                  <Button
                    variant="outline"
                    size="default"
                    data-testid="button-range-export-excel"
                    onClick={() => setRangePrintDialog("excel")}
                    disabled={!rangeStart || !rangeEnd || isExportingRange}
                    className="rounded-xl"
                  >
                    <FileDown className="mr-1.5 h-4 w-4" />
                    {isExportingRange ? "Exporting…" : "Export Range Excel"}
                  </Button>
                  <Button
                    variant="outline"
                    size="default"
                    data-testid="button-range-print"
                    onClick={() => setRangePrintDialog("print")}
                    disabled={!rangeStart || !rangeEnd || isExportingRange}
                    className="rounded-xl"
                  >
                    <Printer className="mr-1.5 h-4 w-4" />
                    Print Range
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary Cards */}
          {workers.length > 0 && (
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
              <SummaryCard
                icon={<Users className="h-4 w-4" />}
                label="Total"
                value={counts.total}
                color="text-foreground"
                testId="stat-total"
                modern
              />
              <SummaryCard
                icon={<CheckCircle className="h-4 w-4" />}
                label="Present"
                value={counts.present}
                color="text-green-600 dark:text-green-400"
                testId="stat-present"
                modern
              />
              <SummaryCard
                icon={<XCircle className="h-4 w-4" />}
                label="Absent"
                value={counts.absent}
                color="text-red-600 dark:text-red-400"
                testId="stat-absent"
                modern
              />
              <SummaryCard
                icon={<Clock className="h-4 w-4" />}
                label="Other"
                value={counts.other}
                color="text-amber-600 dark:text-amber-400"
                testId="stat-other"
                modern
              />
            </div>
          )}

          {/* Attendance Table */}
          <Card className="overflow-hidden border-border/70 bg-card/75 shadow-none">
            <CardHeader className="flex flex-row items-center justify-between gap-3 border-b border-border/60 bg-muted/15 px-4 py-4 sm:px-5">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2 text-base">
                  <CalendarDays className="h-4 w-4 text-primary" />
                  Workers
                  {shift && <Badge variant="secondary" className="rounded-full">{shift}</Badge>}
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
                  <div className="hidden overflow-x-auto sm:block">
                    <table className="w-full text-sm">
                      <thead className="sticky top-0 z-30 bg-muted/30 backdrop-blur">
                        <tr className="border-b border-border/60">
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
                              className="border-b border-border/50 transition-colors last:border-0 hover:bg-muted/20"
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
                                    className={`h-9 rounded-lg bg-background/70 text-xs font-medium ${STATUS_COLORS[status] ?? ""}`}
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
                                  className="h-9 rounded-lg bg-background/70 text-xs"
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
                    {workers.map((worker, idx) => {
                      const status = attendanceMap[worker.id] ?? "Present";
                      return (
                        <div
                          key={worker.id}
                          data-testid={`card-worker-${worker.id}`}
                          className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-3.5 shadow-sm"
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
                              className={`h-10 rounded-lg bg-background/70 text-sm font-medium ${STATUS_COLORS[status] ?? ""}`}
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
                            className="h-9 rounded-lg bg-background/70 text-xs"
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

      <div
        ref={attendanceReportRef}
        aria-hidden="true"
        style={{
          position: "fixed",
          left: "-12000px",
          top: 0,
          width: "1080px",
          background: "#111315",
          color: "#f4f4f5",
          padding: "28px",
          fontFamily: "Arial, sans-serif",
        }}
      >
        <div style={{ marginBottom: "18px", display: "flex", justifyContent: "space-between", alignItems: "end" }}>
          <div>
            <div style={{ fontSize: "26px", fontWeight: 700 }}>Attendance Report</div>
            <div style={{ marginTop: "5px", color: "#a1a1aa", fontSize: "15px" }}>{selectedDate}</div>
          </div>
          <div style={{ color: "#a1a1aa", fontSize: "14px" }}>{counts.total} total workers</div>
        </div>

        <div
          data-testid="attendance-report-kpis"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
            gap: "12px",
            marginBottom: "18px",
          }}
        >
          {[
            { key: "total", label: "Total", value: counts.total, border: "#34383e", valueColor: "#f4f4f5" },
            { key: "present", label: "Present", value: counts.present, border: "#14532d", valueColor: "#34d399" },
            { key: "absent", label: "Absent", value: counts.absent, border: "#7f1d1d", valueColor: "#f87171" },
            { key: "other", label: "Other", value: counts.other, border: "#78350f", valueColor: "#fbbf24" },
          ].map((kpi) => (
            <div
              key={kpi.key}
              data-testid={`attendance-report-kpi-${kpi.key}`}
              style={{
                minWidth: 0,
                border: `1px solid ${kpi.border}`,
                borderRadius: "12px",
                background: "#181a1e",
                padding: "15px 17px",
              }}
            >
              <div
                style={{
                  color: "#a1a1aa",
                  fontSize: "13px",
                  fontWeight: 700,
                  letterSpacing: "0.04em",
                  textTransform: "uppercase",
                }}
              >
                {kpi.label}
              </div>
              <div
                style={{
                  marginTop: "6px",
                  color: kpi.valueColor,
                  fontSize: "30px",
                  lineHeight: 1,
                  fontWeight: 800,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {kpi.value}
              </div>
            </div>
          ))}
        </div>

        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed", fontSize: "18px" }}>
          <thead>
            <tr style={{ background: "#292c31", color: "#f4f4f5" }}>
              <th style={{ width: "160px", padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>
                Code
              </th>
              <th style={{ padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>Worker</th>
              <th style={{ width: "150px", padding: "16px 14px", textAlign: "center", border: "1px solid #3f444b" }}>
                Status
              </th>
              <th style={{ width: "300px", padding: "16px 14px", textAlign: "left", border: "1px solid #3f444b" }}>
                Notes
              </th>
            </tr>
          </thead>
          <tbody>
            {reportAbsentWorkers.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  style={{ padding: "30px 14px", textAlign: "center", color: "#a1a1aa", border: "1px solid #3f444b" }}
                >
                  No absent workers.
                </td>
              </tr>
            ) : (
              reportAbsentWorkers.map((worker, index) => (
                <tr
                  key={`attendance-report-${worker.id}`}
                  style={{ background: index % 2 === 0 ? "#111315" : "#181a1e" }}
                >
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                    {worker.employeeCode || "—"}
                  </td>
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e" }}>
                    <div dir="auto" style={{ fontWeight: 600 }}>{worker.fullName}</div>
                    <div style={{ marginTop: "4px", color: "#8b9098", fontSize: "13px" }}>
                      {worker.position || worker.department || "—"}
                    </div>
                  </td>
                  <td
                    style={{
                      padding: "15px 14px",
                      textAlign: "center",
                      border: "1px solid #34383e",
                      color: "#f87171",
                      fontWeight: 700,
                    }}
                  >
                    Absent
                  </td>
                  <td style={{ padding: "15px 14px", border: "1px solid #34383e", color: "#d4d4d8" }}>
                    {notesMap[worker.id] || "—"}
                  </td>
                </tr>
              ))
            )}
            <tr style={{ background: "#292c31" }}>
              <td colSpan={2} style={{ padding: "18px 14px", border: "1px solid #3f444b", fontWeight: 700 }}>
                Daily Total
              </td>
              <td style={{ padding: "14px", textAlign: "center", border: "1px solid #3f444b", color: "#f87171", fontWeight: 800 }}>
                {counts.absent} absent
              </td>
              <td style={{ padding: "14px", textAlign: "center", border: "1px solid #3f444b", fontWeight: 800 }}>
                {attendancePct}% present
              </td>
            </tr>
          </tbody>
        </table>
      </div>

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
    </div>
  );
}

// ── Per Worker View ────────────────────────────────────────────────────────────
