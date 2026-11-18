// Extracted from ./FactoryAttendance.tsx to keep that module under the source-size cap.
import {
  exportWeeklyExcel,
  generateWeeklyBlankSheetHtml,
  generateWeeklyResultsSheetHtml,
  getWeekDays,
} from "./factoryattendance/utils";
import { useFactoryAttendanceStatePart1 } from "./useFactoryAttendanceStatePart1";

export function useFactoryAttendanceState() {
  const {
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
  } = useFactoryAttendanceStatePart1();
  const { attendancePct, counts, handlePrintWithLang, rangeInvalid, reportAbsentWorkers, visibleWorkers, workers } =
    useFactoryAttendanceStatePart2({
      attendanceMap,
      data,
      notesMap,
      openPrintWindow,
      printDialog,
      rangeEnd,
      rangeStart,
      selectedDate,
      setPrintDialog,
      shift,
      statusFilter,
      workerSearch,
    });
  return {
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
  };
}

function useFactoryAttendanceStatePart2({
  attendanceMap,
  data,
  notesMap,
  openPrintWindow,
  printDialog,
  rangeEnd,
  rangeStart,
  selectedDate,
  setPrintDialog,
  shift,
  statusFilter,
  workerSearch,
}: Pick<
  Awaited<ReturnType<typeof useFactoryAttendanceStatePart1>>,
  | "attendanceMap"
  | "data"
  | "notesMap"
  | "openPrintWindow"
  | "printDialog"
  | "rangeEnd"
  | "rangeStart"
  | "selectedDate"
  | "setPrintDialog"
  | "shift"
  | "statusFilter"
  | "workerSearch"
>) {
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
  const rangeInvalid = Boolean(rangeStart && rangeEnd && rangeStart > rangeEnd);
  const workerSearchNeedle = workerSearch.trim().toLowerCase();
  const visibleWorkers = workers.filter((worker) => {
    const status = attendanceMap[worker.id] ?? "Present";
    const matchesSearch =
      !workerSearchNeedle ||
      worker.fullName.toLowerCase().includes(workerSearchNeedle) ||
      (worker.employeeCode ?? "").toLowerCase().includes(workerSearchNeedle) ||
      (worker.position ?? "").toLowerCase().includes(workerSearchNeedle) ||
      (worker.department ?? "").toLowerCase().includes(workerSearchNeedle);
    const matchesStatus =
      statusFilter === "all" ||
      (statusFilter === "present" && status === "Present") ||
      (statusFilter === "absent" && status === "Absent") ||
      (statusFilter === "other" && status !== "Present" && status !== "Absent");
    return matchesSearch && matchesStatus;
  });
  return { attendancePct, counts, handlePrintWithLang, rangeInvalid, reportAbsentWorkers, visibleWorkers, workers };
}
