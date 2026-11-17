import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
// Extracted from ./utils.tsx to keep that module under the source-size cap.
import * as XLSX from "@/lib/excelHelper";
import type { AttendanceStatus, PrintLang, ViewMode, WeekDay, WorkerRow } from "./types";
import { exportFileName } from "@/lib/exportFile";

export const STATUS_OPTIONS: AttendanceStatus[] = ["Present", "Absent", "Late", "Half Day", "Leave"];

export const STATUS_COLORS: Record<string, string> = {
  Present: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  Absent: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  Late: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "Half Day": "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Leave: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
};

// Format a Date as YYYY-MM-DD using local time (not UTC) to avoid
// timezone-shift bugs where toISOString() returns the previous day in UTC+ zones.

export // Format a Date as YYYY-MM-DD using local time (not UTC) to avoid
// timezone-shift bugs where toISOString() returns the previous day in UTC+ zones.
function localDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function todayStr() {
  return localDateStr(new Date());
}

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

export function getInitialMode(): ViewMode {
  const p = new URLSearchParams(window.location.search);
  return p.get("mode") === "perWorker" ? "perWorker" : "daily";
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

export const LABELS = {
  en: {
    title: "Weekly Attendance Sheet",
    resultTitle: "Weekly Attendance Report",
    workerName: "Worker Name",
    notes: "Notes / Signature",
    preparedBy: "Prepared By",
    supervisor: "Supervisor",
    approvedBy: "Approved By",
    totalWorkers: "Total Workers",
    week: "Week",
    shift: "Shift",
    present: "P = Present",
    absent: "A = Absent",
    mark: "Mark P / A or \u2713 / \u2717 in each cell",
  },
  ar: {
    title: "\u0643\u0634\u0641 \u0627\u0644\u062D\u0636\u0648\u0631 \u0627\u0644\u0623\u0633\u0628\u0648\u0639\u064A",
    resultTitle:
      "\u062A\u0642\u0631\u064A\u0631 \u0627\u0644\u062D\u0636\u0648\u0631 \u0627\u0644\u0623\u0633\u0628\u0648\u0639\u064A",
    workerName: "\u0627\u0633\u0645 \u0627\u0644\u0639\u0627\u0645\u0644",
    notes: "\u0645\u0644\u0627\u062D\u0638\u0627\u062A / \u062A\u0648\u0642\u064A\u0639",
    preparedBy: "\u0623\u0639\u062F\u0647",
    supervisor: "\u0627\u0644\u0645\u0634\u0631\u0641",
    approvedBy: "\u0627\u0639\u062A\u0645\u062F\u0647",
    totalWorkers: "\u0645\u062C\u0645\u0648\u0639 \u0627\u0644\u0639\u0645\u0627\u0644",
    week: "\u0627\u0644\u0623\u0633\u0628\u0648\u0639",
    shift: "\u0627\u0644\u0648\u0631\u062F\u064A\u0629",
    present: "\u062D = \u062D\u0627\u0636\u0631",
    absent: "\u063A = \u063A\u0627\u0626\u0628",
    mark: "\u0636\u0639 \u062D / \u063A \u0623\u0648 \u2713 / \u2717 \u0641\u064A \u0643\u0644 \u062E\u0627\u0646\u0629",
  },
} as const;

export function weekLabel(weekDays: WeekDay[]): string {
  const first = weekDays[0].date;
  const last = weekDays[weekDays.length - 1].date;
  const fmt = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return `${fmt(first)} \u2013 ${fmt(last)}, ${last.getFullYear()}`;
}

export const WEEKLY_CSS = `
  @page { size: A4 landscape; margin: 10mm 12mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Tahoma, Arial, 'Noto Sans Arabic', sans-serif; font-size: 7.5pt; color: #111; margin: 0; }
  h1 { font-size: 13pt; text-align: center; margin: 0 0 2px; }
  .subtitle { text-align: center; font-size: 8pt; color: #555; margin-bottom: 6px; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; table-layout: fixed; }
  col.col-num   { width: 3%; }
  col.col-name  { width: 22%; }
  col.col-day   { width: 10%; }
  col.col-notes { width: 13%; }
  th { background: #e8e8e8; border: 1px solid #aaa; padding: 3px 2px; font-size: 7pt; text-align: center; white-space: nowrap; overflow: hidden; }
  th.name-col { text-align: left; }
  td { border: 1px solid #ccc; padding: 2px 3px; font-size: 7.5pt; vertical-align: middle; height: 17px; }
  td.num { text-align: center; color: #888; }
  td.name { text-align: left; unicode-bidi: plaintext; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  td.day { text-align: center; }
  td.notes { font-size: 7pt; }
  tr:nth-child(even) td { background: #f7f7f7; }
  .legend { margin-top: 6px; font-size: 7pt; color: #555; text-align: center; }
  .legend span { margin: 0 10px; }
  .footer { margin-top: 12px; display: flex; justify-content: space-between; font-size: 7.5pt; }
  .footer div { border-top: 1px solid #333; padding-top: 3px; width: 120px; text-align: center; }
  @media print { button { display: none; } }
`;

export const STATUS_MARKS: Record<string, string> = {
  Present: "\u2713",
  Absent: "\u2717",
  Late: "L",
  "Half Day": "\u00BD",
  Leave: "\u2014",
};

export function buildWeeklySheet(
  workers: WorkerRow[],
  weekDays: WeekDay[],
  shift: string,
  lang: PrintLang,
  type: "blank" | "results",
  attendanceMap: Record<number, AttendanceStatus>,
  notesMap: Record<number, string>,
  selectedDate: string,
  sheetLabel: string
) {
  const L = LABELS[lang];
  const dayColHeaders = weekDays.map((d) => `${lang === "ar" ? d.dayNameAr : d.dayName} ${d.dayNum}`);
  const headers = ["#", L.workerName, ...dayColHeaders, L.notes];

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

  const subtitle = `${sheetLabel}  |  ${L.week}: ${weekLabel(weekDays)}${shift ? `  |  ${L.shift}: ${shift}` : ""}  |  ${L.totalWorkers}: ${workers.length}`;
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
  selectedDate: string
) {
  const wb = XLSX.utils.book_new();

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
    lang === "ar" ? "العمال النشطون" : "Active Workers"
  );
  XLSX.utils.book_append_sheet(wb, activeSheet, lang === "ar" ? "نشط" : "Active Workers");

  const inactiveSheet = buildWeeklySheet(
    inactiveWorkers,
    weekDays,
    shift,
    lang,
    type,
    {},
    {},
    selectedDate,
    lang === "ar" ? "العمال غير النشطين" : "Inactive Workers"
  );
  XLSX.utils.book_append_sheet(wb, inactiveSheet, lang === "ar" ? "غير نشط" : "Inactive Workers");

  styleFactoryOperationalWorkbook(wb, [
    { name: lang === "ar" ? "نشط" : "Active Workers", titleRow: 1, headerRow: 3 },
    { name: lang === "ar" ? "غير نشط" : "Inactive Workers", titleRow: 1, headerRow: 3 },
  ]);
  await XLSX.writeFile(
    wb,
    exportFileName(`attendance ${type}`, "xlsx", {
      from: weekDays[0]?.date,
      to: weekDays[weekDays.length - 1]?.date,
    })
  );
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
