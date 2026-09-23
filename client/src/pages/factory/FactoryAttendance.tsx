import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  todayStr,
} from "./factoryattendance/utils";
import { PerWorkerView } from "./factoryattendance/components/PerWorkerView";
import { SummaryCard } from "./factoryattendance/components/SummaryCard";

interface AttendanceWhatsappSettings {
  attendanceWhatsappGroupId?: string | null;
}

interface WhatsappChat {
  id: string;
  name: string;
  type: string;
}

export default function FactoryAttendance() {
  const { toast } = useToast();
  const [mode] = useState<ViewMode>(getInitialMode);

  // ── Daily attendance state ────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<string>(todayStr());
  // Shift is intentionally no longer user-selectable on this screen.
  const shift = "";

  // ── Range export state ────────────────────────────────────────
  const [rangeStart, setRangeStart] = useState<string>(todayStr());
  const [rangeEnd, setRangeEnd] = useState<string>(todayStr());
  const [isExportingRange, setIsExportingRange] = useState(false);
  const [rangePrintDialog, setRangePrintDialog] = useState<"excel" | "print" | null>(null);
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});
  const [attendanceWaPickerOpen, setAttendanceWaPickerOpen] = useState(false);
  const [attendanceWaGroupId, setAttendanceWaGroupId] = useState("");
  const [attendanceWaSearch, setAttendanceWaSearch] = useState("");
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

  const { data: attendanceWaChats = [], isLoading: attendanceWaChatsLoading } = useQuery<WhatsappChat[]>({
    queryKey: ["/api/whatsapp/chats"],
    queryFn: async () => {
      const res = await factoryApiRequest("GET", "/api/whatsapp/chats");
      if (!res.ok) throw new Error("Failed to load WhatsApp groups");
      return res.json();
    },
    enabled: attendanceWaPickerOpen,
    staleTime: 60_000,
    retry: false,
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

  useEffect(() => {
    if (attendanceWhatsappSettings) {
      setAttendanceWaGroupId(attendanceWhatsappSettings.attendanceWhatsappGroupId ?? "");
    }
  }, [attendanceWhatsappSettings]);

  const filteredAttendanceWaChats = useMemo(() => {
    const needle = attendanceWaSearch.trim().toLowerCase();
    return attendanceWaChats.filter((chat) => {
      const isGroup = chat.id.endsWith("@g.us") || chat.type?.toLowerCase().includes("group");
      const matches = !needle || chat.name?.toLowerCase().includes(needle) || chat.id.toLowerCase().includes(needle);
      return isGroup && matches;
    });
  }, [attendanceWaChats, attendanceWaSearch]);

  const saveAttendanceWaGroupMutation = useMutation({
    mutationFn: async (chatId: string) => {
      const res = await factoryApiRequest("PUT", "/api/factory/settings?scope=attendance", {
        attendanceWhatsappGroupId: chatId,
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || "Failed to save Attendance WhatsApp group");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/settings?scope=attendance"] });
      setAttendanceWaPickerOpen(false);
      setAttendanceWaSearch("");
      toast({ title: "Attendance WhatsApp group updated" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to save WhatsApp group", description: err.message, variant: "destructive" });
    },
  });

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
    <div className="space-y-4 p-1">
      {mode === "perWorker" ? (
        <PerWorkerView />
      ) : (
        <>
          {/* Attendance controls + range tools */}
          <Card>
            <CardContent className="p-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(520px,0.9fr)] xl:gap-0">
                <div className="space-y-3 xl:pr-5">
                  <div className="flex items-center gap-2">
                    <CalendarDays className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-semibold">Attendance</p>
                      <p className="text-xs text-muted-foreground">Choose the date and manage today&apos;s register.</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1.5">
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

                    <div className="flex flex-1 flex-wrap items-center gap-2">
                      <Button
                        variant="outline"
                        size="default"
                        onClick={() => setAttendanceWaPickerOpen((open) => !open)}
                        data-testid="button-change-attendance-whatsapp-group"
                      >
                        <MessageCircle className="h-4 w-4 mr-1" />
                        {attendanceWaGroupId ? "Change WhatsApp Group" : "Set WhatsApp Group"}
                      </Button>
                      <Button
                        variant="outline"
                        size="default"
                        onClick={() => sendWhatsappImageMutation.mutate()}
                        disabled={
                          !attendanceWaGroupId ||
                          !workers.length ||
                          isLoading ||
                          sendWhatsappImageMutation.isPending
                        }
                        data-testid="button-send-attendance-whatsapp-image"
                      >
                        {sendWhatsappImageMutation.isPending ? (
                          <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                        ) : (
                          <MessageCircle className="h-4 w-4 mr-1" />
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
                </div>

                <div className="space-y-3 border-t pt-4 xl:border-l xl:border-t-0 xl:pl-5 xl:pt-0">
                  <div className="flex items-center gap-2">
                    <FileDown className="h-4 w-4 text-muted-foreground" />
                    <div>
                      <p className="text-sm font-semibold">Range Export</p>
                      <p className="text-xs text-muted-foreground">Export or print attendance for a date range.</p>
                    </div>
                  </div>

                  <div className="flex flex-wrap items-end gap-2">
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">From</Label>
                      <Input
                        type="date"
                        data-testid="input-range-start"
                        value={rangeStart}
                        onChange={(e) => setRangeStart(e.target.value)}
                        className="w-40"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <Label className="text-xs text-muted-foreground">To</Label>
                      <Input
                        type="date"
                        data-testid="input-range-end"
                        value={rangeEnd}
                        onChange={(e) => setRangeEnd(e.target.value)}
                        className="w-40"
                      />
                    </div>
                    <Button
                      variant="outline"
                      size="default"
                      data-testid="button-range-export-excel"
                      onClick={() => setRangePrintDialog("excel")}
                      disabled={!rangeStart || !rangeEnd || isExportingRange}
                    >
                      <FileDown className="h-4 w-4 mr-1" />
                      {isExportingRange ? "Exporting…" : "Excel"}
                    </Button>
                    <Button
                      variant="outline"
                      size="default"
                      data-testid="button-range-print"
                      onClick={() => setRangePrintDialog("print")}
                      disabled={!rangeStart || !rangeEnd || isExportingRange}
                    >
                      <Printer className="h-4 w-4 mr-1" />
                      Print
                    </Button>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {attendanceWaPickerOpen && (
            <Card>
              <CardContent className="pt-4 space-y-3">
                <div>
                  <p className="text-sm font-semibold">Attendance WhatsApp Group</p>
                  <p className="text-xs text-muted-foreground">
                    This group is used only for attendance images sent from Payroll & Benefits.
                  </p>
                </div>
                <Input
                  value={attendanceWaSearch}
                  onChange={(event) => setAttendanceWaSearch(event.target.value)}
                  placeholder="Search WhatsApp groups..."
                  data-testid="input-attendance-wa-search"
                />
                <div className="max-h-48 overflow-y-auto rounded-md border text-sm">
                  {attendanceWaChatsLoading ? (
                    <div className="flex items-center justify-center gap-2 py-5 text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      Loading WhatsApp groups...
                    </div>
                  ) : filteredAttendanceWaChats.length === 0 ? (
                    <p className="py-5 text-center text-muted-foreground">No WhatsApp groups found.</p>
                  ) : (
                    filteredAttendanceWaChats.map((chat) => (
                      <button
                        key={chat.id}
                        type="button"
                        onClick={() => setAttendanceWaGroupId(chat.id)}
                        className={`w-full border-b px-3 py-2 text-left last:border-b-0 hover:bg-muted/60 ${
                          attendanceWaGroupId === chat.id ? "bg-primary/10 text-primary" : ""
                        }`}
                        data-testid={`option-attendance-wa-chat-${chat.id}`}
                      >
                        <div className="font-medium">{chat.name || chat.id}</div>
                        <div className="text-xs text-muted-foreground">{chat.id}</div>
                      </button>
                    ))
                  )}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    {attendanceWaGroupId
                      ? `Selected group: ${attendanceWaGroupId}`
                      : "No Attendance WhatsApp group selected."}
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        setAttendanceWaGroupId(attendanceWhatsappSettings?.attendanceWhatsappGroupId ?? "");
                        setAttendanceWaPickerOpen(false);
                        setAttendanceWaSearch("");
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => saveAttendanceWaGroupMutation.mutate(attendanceWaGroupId)}
                      disabled={!attendanceWaGroupId || saveAttendanceWaGroupMutation.isPending}
                      data-testid="button-save-attendance-wa-group"
                    >
                      {saveAttendanceWaGroupMutation.isPending && (
                        <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                      )}
                      Save Group
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

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
  );
}

// ── Per Worker View ────────────────────────────────────────────────────────────
