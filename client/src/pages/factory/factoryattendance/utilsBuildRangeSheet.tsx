// Extracted from ./utils.tsx to keep that module under the source-size cap.
import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import * as XLSX from "@/lib/excelHelper";
import type { AttendanceStatus, PrintLang, ViewMode, WeekDay, WorkerRow } from "./types";
import { localDateStr, LABELS, STATUS_MARKS, type AttendancePersonKind } from "./utilsBuildRangeSheetHelpers";
export {
  STATUS_COLORS,
  localDateStr,
  todayStr,
  LABELS,
  WEEKLY_CSS,
  WEEKLY_COLGROUP,
  STATUS_MARKS,
  type AttendancePersonKind,
} from "./utilsBuildRangeSheetHelpers";

// Format a Date as YYYY-MM-DD using local time (not UTC) to avoid
// timezone-shift bugs where toISOString() returns the previous day in UTC+ zones.

export function generateDateRange(start: string, end: string): string[] {
  const dates: string[] = [];
  const cur = new Date(start + "T00:00:00");
  const endDate = new Date(end + "T00:00:00");
  while (cur <= endDate) {
    dates.push(localDateStr(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

export function setModeInUrl(mode: ViewMode) {
  const url = new URL(window.location.href);
  if (mode === "daily") {
    url.searchParams.delete("mode");
  } else {
    url.searchParams.set("mode", mode);
  }
  window.history.replaceState(null, "", url.toString());
}

export function formatDate(dateStr: string) {
  try {
    return new Date(dateStr + "T00:00:00").toLocaleDateString(undefined, {
      weekday: "short",
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  } catch {
    return dateStr;
  }
}

export function getWeekDays(dateStr: string): WeekDay[] {
  const d = new Date(dateStr + "T00:00:00");
  const dow = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((dow === 0 ? 7 : dow) - 1));
  const enNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const arNames = [
    "\u0627\u0644\u0627\u062B\u0646\u064A\u0646",
    "\u0627\u0644\u062B\u0644\u0627\u062B\u0627\u0621",
    "\u0627\u0644\u0623\u0631\u0628\u0639\u0627\u0621",
    "\u0627\u0644\u062E\u0645\u064A\u0633",
    "\u0627\u0644\u062C\u0645\u0639\u0629",
    "\u0627\u0644\u0633\u0628\u062A",
  ];
  const days: WeekDay[] = [];
  for (let i = 0; i < 6; i++) {
    const cur = new Date(monday);
    cur.setDate(monday.getDate() + i);
    days.push({
      dayName: enNames[i],
      dayNameAr: arNames[i],
      date: cur,
      iso: `${cur.getFullYear()}-${String(cur.getMonth() + 1).padStart(2, "0")}-${String(cur.getDate()).padStart(2, "0")}`,
      dayNum: cur.getDate(),
    });
  }
  return days;
}

/** Name column, count and sheet labels for worker or employee attendance sheets. */
export const PERSON_LABELS: Record<
  AttendancePersonKind,
  Record<
    PrintLang,
    { name: string; total: string; active: string; inactive: string; activeSheet: string; inactiveSheet: string }
  >
> = {
  worker: {
    en: {
      name: LABELS.en.workerName,
      total: LABELS.en.totalWorkers,
      active: "Active Workers",
      inactive: "Inactive Workers",
      activeSheet: "Active Workers",
      inactiveSheet: "Inactive Workers",
    },
    ar: {
      name: LABELS.ar.workerName,
      total: LABELS.ar.totalWorkers,
      active: "العمال النشطون",
      inactive: "العمال غير النشطين",
      activeSheet: "نشط",
      inactiveSheet: "غير نشط",
    },
  },
  employee: {
    en: {
      name: "Employee Name",
      total: "Total Employees",
      active: "Active Employees",
      inactive: "Inactive Employees",
      activeSheet: "Active Employees",
      inactiveSheet: "Inactive Employees",
    },
    ar: {
      name: "اسم الموظف",
      total: "مجموع الموظفين",
      active: "الموظفون النشطون",
      inactive: "الموظفون غير النشطين",
      activeSheet: "نشط",
      inactiveSheet: "غير نشط",
    },
  },
};

export function weekLabel(weekDays: WeekDay[]): string {
  const first = weekDays[0].date;
  const last = weekDays[weekDays.length - 1].date;
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(first)} \u2013 ${fmt(last)}, ${last.getFullYear()}`;
}

export function buildWeeklySheet(
  workers: WorkerRow[],
  weekDays: WeekDay[],
  shift: string,
  lang: PrintLang,
  type: "blank" | "results",
  attendanceMap: Record<number, AttendanceStatus>,
  notesMap: Record<number, string>,
  selectedDate: string,
  sheetLabel: string,
  kind: AttendancePersonKind = "worker"
) {
  const L = LABELS[lang];
  const P = PERSON_LABELS[kind][lang];
  const dayColHeaders = weekDays.map((d) => `${lang === "ar" ? d.dayNameAr : d.dayName} ${d.dayNum}`);
  const headers = ["#", P.name, ...dayColHeaders, L.notes];

  const dataRows = workers.map((w, i) => {
    const dayCells = weekDays.map((d) => {
      if (type === "results" && d.iso === selectedDate) {
        const s = attendanceMap[w.id] ?? "Present";
        return STATUS_MARKS[s] ?? s.charAt(0);
      }
      return "";
    });
    const notes = type === "results" ? (notesMap[w.id] ?? "") : "";
    return [i + 1, w.fullName, ...dayCells, notes];
  });

  const totalCols = 2 + weekDays.length + 1;
  const colWidths = [{ wch: 4 }, { wch: 30 }, ...weekDays.map(() => ({ wch: 10 })), { wch: 22 }];

  const subtitle = `${sheetLabel}  |  ${L.week}: ${weekLabel(weekDays)}${shift ? `  |  ${L.shift}: ${shift}` : ""}  |  ${P.total}: ${workers.length}`;
  const allRows = [[L.title], [subtitle], headers, ...dataRows];
  const ws = XLSX.utils.aoa_to_sheet(allRows);
  ws["!cols"] = colWidths;
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
  ];
  return ws;
}

export async function exportWeeklyExcel(
  workers: WorkerRow[],
  weekDays: WeekDay[],
  shift: string,
  lang: PrintLang,
  type: "blank" | "results",
  attendanceMap: Record<number, AttendanceStatus>,
  notesMap: Record<number, string>,
  selectedDate: string,
  kind: AttendancePersonKind = "worker"
) {
  const wb = XLSX.utils.book_new();
  const P = PERSON_LABELS[kind][lang];

  const activeWorkers = workers.filter((w) => w.active !== false);
  const inactiveWorkers = workers.filter((w) => w.active === false);

  const activeSheet = buildWeeklySheet(
    activeWorkers,
    weekDays,
    shift,
    lang,
    type,
    attendanceMap,
    notesMap,
    selectedDate,
    P.active,
    kind
  );
  XLSX.utils.book_append_sheet(wb, activeSheet, P.activeSheet);

  const inactiveSheet = buildWeeklySheet(
    inactiveWorkers,
    weekDays,
    shift,
    lang,
    type,
    {},
    {},
    selectedDate,
    P.inactive,
    kind
  );
  XLSX.utils.book_append_sheet(wb, inactiveSheet, P.inactiveSheet);

  const weekRange = weekLabel(weekDays).replace(/[^a-z0-9]/gi, "-");
  styleFactoryOperationalWorkbook(wb, [
    { name: P.activeSheet, titleRow: 1, headerRow: 3 },
    { name: P.inactiveSheet, titleRow: 1, headerRow: 3 },
  ]);
  const prefix = kind === "employee" ? "employee-attendance" : "attendance";
  await XLSX.writeFile(wb, `${prefix}-${type}-${weekRange}.xlsx`);
}

export function buildRangeSheet(
  workers: WorkerRow[],
  lookup: Map<number, Map<string, string>>,
  dates: string[],
  startDate: string,
  endDate: string,
  lang: PrintLang,
  sheetTitle: string,
  useBlankDefault = false // true for inactive workers: no record = blank cell, not Present
) {
  const dateHeaders = dates.map((d) => {
    const dt = new Date(d + "T00:00:00");
    const day = dt.getDate();
    const weekday = dt.toLocaleDateString(lang === "ar" ? "ar" : "en-US", { weekday: "short" });
    return `${day}\n${weekday}`;
  });

  const workerLabel = lang === "ar" ? "اسم العامل" : "Worker Name";
  const totalPLabel = lang === "ar" ? "الحضور" : "Present";
  const totalALabel = lang === "ar" ? "الغياب" : "Absent";
  const rangeLabel = `${startDate}  →  ${endDate}  |  ${sheetTitle}  |  ${lang === "ar" ? "العمال" : "Workers"}: ${workers.length}`;

  const headers = ["#", workerLabel, ...dateHeaders, totalPLabel, totalALabel];
  const dataRows = workers.map((w, i) => {
    const wMap = lookup.get(w.id) ?? new Map();
    let presentCount = 0;
    let absentCount = 0;
    const dayCells = dates.map((d) => {
      const recorded = wMap.get(d);
      // Inactive workers: if no explicit record exists, leave cell blank.
      const status = recorded ?? (useBlankDefault ? null : "Present");
      if (!status) return ""; // blank cell for inactive with no record
      const mark = STATUS_MARKS[status] ?? status.charAt(0);
      if (status === "Absent") absentCount++;
      else presentCount++;
      return mark;
    });
    return [i + 1, w.fullName, ...dayCells, presentCount || "", absentCount || ""];
  });

  const titleLabel = lang === "ar" ? "كشف الحضور" : "Attendance Sheet";
  const totalCols = 2 + dates.length + 2;
  const allRows = [[titleLabel], [rangeLabel], headers, ...dataRows];

  const ws = XLSX.utils.aoa_to_sheet(allRows);
  ws["!cols"] = [{ wch: 4 }, { wch: 28 }, ...dates.map(() => ({ wch: 6 })), { wch: 9 }, { wch: 9 }];
  ws["!merges"] = [
    { s: { r: 0, c: 0 }, e: { r: 0, c: totalCols - 1 } },
    { s: { r: 1, c: 0 }, e: { r: 1, c: totalCols - 1 } },
  ];
  return ws;
}
