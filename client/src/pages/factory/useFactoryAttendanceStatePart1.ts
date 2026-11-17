// Extracted from ./FactoryAttendance.tsx to keep that module under the source-size cap.
import type { ClientErrorLike } from "@/lib/clientError";
import { getErrorDetails } from "@shared/errorUtils";
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { factoryApiRequest } from "@/lib/factoryApi";
import { useCompany } from "@/contexts/CompanyContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { useToast } from "@/hooks/use-toast";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import type {
  AttendanceBulkRecord,
  AttendanceRecord,
  AttendanceStatus,
  ViewMode,
  WorkerRow,
} from "./factoryattendance/types";
import {
  exportRangeExcel,
  generateDateRange,
  generateRangePrintHtml,
  getInitialMode,
  setModeInUrl,
} from "./factoryattendance/utils";
import {
  type AttendanceAdminCredentials,
  attendancePastDates,
  attendanceToday,
  canSkipAttendanceApproval,
} from "./factoryattendance/attendanceEditPolicy";

interface AttendanceWhatsappSettings {
  attendanceWhatsappGroupId?: string | null;
}

// ── Per Worker View ────────────────────────────────────────────────────────────

export function useFactoryAttendanceStatePart1() {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  // View Only / Create Only roles read attendance but never save or bulk-mark it.
  const recordChanges = useExistingRecordChangeAccess();
  const canEditPastWithoutPassword = useCallback(
    (dates: string[]) => canSkipAttendanceApproval(selectedCompany?.role, dates),
    [selectedCompany?.role]
  );
  const [mode, setMode] = useState<ViewMode>(getInitialMode);

  const showDailyAttendance = () => {
    setMode("daily");
    setModeInUrl("daily");
  };

  // ── Daily attendance state ────────────────────────────────────
  const [selectedDate, setSelectedDate] = useState<string>(attendanceToday);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [approvalDates, setApprovalDates] = useState<string[]>([]);
  const [pendingApprovalRecords, setPendingApprovalRecords] = useState<AttendanceBulkRecord[] | null>(null);
  // Shift is no longer user-selectable on this screen. Keep an empty value for existing save/export payloads.
  const shift = "";

  // ── Range export state ────────────────────────────────────────
  const [rangeStart, setRangeStart] = useState<string>(attendanceToday);
  const [rangeEnd, setRangeEnd] = useState<string>(attendanceToday);
  const [isExportingRange, setIsExportingRange] = useState(false);
  const [rangePrintDialog, setRangePrintDialog] = useState<"excel" | "print" | null>(null);
  const [attendanceMap, setAttendanceMap] = useState<Record<number, AttendanceStatus>>({});
  const [notesMap, setNotesMap] = useState<Record<number, string>>({});
  const [workerSearch, setWorkerSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "present" | "absent" | "other">("all");
  const attendanceReportRef = useRef<HTMLDivElement>(null);

  const { data, isLoading } = useQuery<{ workers: WorkerRow[]; attendance: AttendanceRecord[] }>({
    queryKey: companyQueryKey("/api/factory/attendance", selectedCompany?.id, selectedDate),
    enabled: Boolean(selectedCompany?.id),
    queryFn: async () => {
      const res = await fetch(`/api/factory/attendance?date=${selectedDate}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch attendance");
      return res.json();
    },
  });

  const { data: attendanceWhatsappSettings } = useQuery<AttendanceWhatsappSettings>({
    queryKey: companyQueryKey("/api/factory/settings?scope=attendance", selectedCompany?.id),
    enabled: Boolean(selectedCompany?.id),
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
      newMap[w.id] = w.active === false ? "Absent" : "Present";
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
    mutationFn: (payload: { records: AttendanceBulkRecord[]; credentials?: AttendanceAdminCredentials }) =>
      apiRequest("POST", "/api/factory/attendance/bulk", {
        records: payload.records,
        ...payload.credentials,
      }),
    onSuccess: () => {
      setApprovalOpen(false);
      setPendingApprovalRecords(null);
      queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/attendance", selectedCompany?.id, selectedDate),
      });
      toast({ title: "Attendance saved", description: `Saved for ${selectedDate}` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Save failed", description: err.message, variant: "destructive" });
    },
  });

  const handleSave = useCallback(() => {
    if (!data?.workers.length) return;
    const records = data.workers
      .filter((w) => w.active !== false)
      .map((w) => ({
        workerId: w.id,
        attendanceDate: selectedDate,
        shift: shift || undefined,
        status: attendanceMap[w.id] ?? "Present",
        notes: notesMap[w.id] || undefined,
      }));
    const priorDates = attendancePastDates(records.map((record) => record.attendanceDate));
    if (priorDates.length && !canEditPastWithoutPassword(priorDates)) {
      setApprovalDates(priorDates);
      setPendingApprovalRecords(records);
      setApprovalOpen(true);
    } else {
      saveMutation.mutate({ records });
    }
  }, [data, selectedDate, shift, attendanceMap, notesMap, saveMutation, canEditPastWithoutPassword]);

  const approveAttendanceSave = (credentials: AttendanceAdminCredentials) => {
    if (pendingApprovalRecords) saveMutation.mutate({ records: pendingApprovalRecords, credentials });
  };

  const markAll = (status: AttendanceStatus) => {
    if (!data?.workers) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const w of data.workers.filter((w) => w.active !== false)) next[w.id] = status;
    setAttendanceMap(next);
  };

  const reset = () => {
    if (!data?.workers) return;
    const next: Record<number, AttendanceStatus> = {};
    for (const w of data.workers.filter((w) => w.active !== false)) next[w.id] = "Present";
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
    if (rangeStart > rangeEnd) {
      toast({
        title: "Invalid date range",
        description: "The From date must be before or the same as the To date.",
        variant: "destructive",
      });
      return;
    }
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
      toast({
        title: mode === "print" ? "Print failed" : "Export failed",
        description: getErrorDetails(err).message,
        variant: "destructive",
      });
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
  return {
    approvalDates,
    approvalOpen,
    approveAttendanceSave,
    attendanceMap,
    attendanceReportRef,
    attendanceWaGroupId,
    canEditPastWithoutPassword,
    data,
    handleRangeExport,
    handleSave,
    isExportingRange,
    isLoading,
    markAll,
    mode,
    notesMap,
    openPrintWindow,
    printDialog,
    rangeEnd,
    rangePrintDialog,
    rangeStart,
    recordChanges,
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
    shift,
    showDailyAttendance,
    statusFilter,
    workerSearch,
  };
}
