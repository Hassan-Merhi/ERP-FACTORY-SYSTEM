import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
/**
 * Pure helpers and lookup tables for the FactoryAttendance page.
 *
 * Extracted from FactoryAttendance.tsx during the Phase 4 god-file split.
 */
import * as XLSX from "@/lib/excelHelper";
import type { AttendanceRecord, AttendanceStatus, PrintLang, ViewMode, WeekDay, WorkerRow } from "./types";
import { LABELS, STATUS_MARKS, WEEKLY_COLGROUP, WEEKLY_CSS, buildRangeSheet, weekLabel } from "./utilsBuildRangeSheet";
export {
  LABELS,
  STATUS_COLORS,
  STATUS_MARKS,
  WEEKLY_COLGROUP,
  WEEKLY_CSS,
  buildRangeSheet,
  buildWeeklySheet,
  exportWeeklyExcel,
  formatDate,
  generateDateRange,
  getWeekDays,
  localDateStr,
  setModeInUrl,
  todayStr,
  weekLabel,
} from "./utilsBuildRangeSheet";

export const STATUS_OPTIONS: AttendanceStatus[] = ["Present", "Absent", "Late", "Half Day", "Leave"];

export function getInitialMode(): ViewMode {
  const p = new URLSearchParams(window.location.search);
  return p.get("mode") === "perWorker" ? "perWorker" : "daily";
}

export function generateWeeklyBlankSheetHtml(
  workers: WorkerRow[],
  weekDays: WeekDay[],
  shift: string,
  lang: PrintLang
) {
  const L = LABELS[lang];
  const dayHeaders = weekDays
    .map((d) => {
      const name = lang === "ar" ? d.dayNameAr : d.dayName;
      return `<th>${name}<br/>${d.dayNum}</th>`;
    })
    .join("");

  const rows = workers
    .map((w, i) => {
      const dayCells = weekDays.map(() => `<td class="day"></td>`).join("");
      return `<tr>
      <td class="num">${i + 1}</td>
      <td class="name" dir="auto">${escHtml(w.fullName)}</td>
      ${dayCells}
      <td class="notes"></td>
    </tr>`;
    })
    .join("");

  const htmlLang = lang === "ar" ? "ar" : "en";

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="ltr">
<head>
  <meta charset="utf-8" />
  <title>${L.title}</title>
  <style>
    ${WEEKLY_CSS}
  </style>
</head>
<body>
  <h1>${L.title}</h1>
  <div class="subtitle">
    ${L.week}: <strong>${weekLabel(weekDays)}</strong>
    ${shift ? `&nbsp;&nbsp;|&nbsp;&nbsp; ${L.shift}: <strong>${escHtml(shift)}</strong>` : ""}
    &nbsp;&nbsp;|&nbsp;&nbsp; ${L.totalWorkers}: <strong>${workers.length}</strong>
  </div>
  <table>
    ${WEEKLY_COLGROUP}
    <thead className="sticky top-0 z-30 bg-muted">
      <tr>
        <th>#</th>
        <th class="name-col">${L.workerName}</th>
        ${dayHeaders}
        <th>${L.notes}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="legend">
    <span><strong>${lang === "ar" ? "\u062D" : "P"}</strong> = ${lang === "ar" ? "\u062D\u0627\u0636\u0631" : "Present"}</span>
    <span><strong>${lang === "ar" ? "\u063A" : "A"}</strong> = ${lang === "ar" ? "\u063A\u0627\u0626\u0628" : "Absent"}</span>
    <span>${L.mark}</span>
  </div>
  <div class="footer">
    <div>${L.preparedBy}</div>
    <div>${L.supervisor}</div>
    <div>${L.approvedBy}</div>
  </div>
</body>
</html>`;
}

export const STATUS_PRINT_COLORS: Record<string, string> = {
  Present: "#15803d",
  Absent: "#b91c1c",
  Late: "#b45309",
  "Half Day": "#1d4ed8",
  Leave: "#7e22ce",
};

export function generateWeeklyResultsSheetHtml(
  workers: WorkerRow[],
  attendanceMap: Record<number, AttendanceStatus>,
  notesMap: Record<number, string>,
  weekDays: WeekDay[],
  selectedDate: string,
  shift: string,
  lang: PrintLang
) {
  const L = LABELS[lang];

  const dayHeaders = weekDays
    .map((d) => {
      const name = lang === "ar" ? d.dayNameAr : d.dayName;
      const isSelected = d.iso === selectedDate;
      const bg = isSelected ? ' style="background:#d0e0f0"' : "";
      return `<th${bg}>${name}<br/>${d.dayNum}</th>`;
    })
    .join("");

  const present = workers.filter((w) => (attendanceMap[w.id] ?? "Present") === "Present").length;
  const absent = workers.filter((w) => attendanceMap[w.id] === "Absent").length;

  const rows = workers
    .map((w, i) => {
      const status = attendanceMap[w.id] ?? "Present";
      const color = STATUS_PRINT_COLORS[status] ?? "#374151";
      const mark = STATUS_MARKS[status] ?? escHtml(status.charAt(0));
      const notes = escHtml(notesMap[w.id] ?? "");

      const dayCells = weekDays
        .map((d) => {
          if (d.iso === selectedDate) {
            return `<td class="day" style="font-weight:700;color:${color};font-size:9pt">${mark}</td>`;
          }
          return `<td class="day"></td>`;
        })
        .join("");

      return `<tr>
      <td class="num">${i + 1}</td>
      <td class="name" dir="auto">${escHtml(w.fullName)}</td>
      ${dayCells}
      <td class="notes" style="color:#555">${notes}</td>
    </tr>`;
    })
    .join("");

  const htmlLang = lang === "ar" ? "ar" : "en";

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="ltr">
<head>
  <meta charset="utf-8" />
  <title>${L.resultTitle}</title>
  <style>
    ${WEEKLY_CSS}
    .summary { display:flex; gap:20px; justify-content:center; margin-bottom:6px; font-size:8pt; }
    .summary span { font-weight:600; }
  </style>
</head>
<body>
  <h1>${L.resultTitle}</h1>
  <div class="subtitle">
    ${L.week}: <strong>${weekLabel(weekDays)}</strong>
    ${shift ? `&nbsp;&nbsp;|&nbsp;&nbsp; ${L.shift}: <strong>${escHtml(shift)}</strong>` : ""}
  </div>
  <div class="summary">
    <div>${L.totalWorkers}: <span>${workers.length}</span></div>
    <div>${lang === "ar" ? "\u062D\u0627\u0636\u0631" : "Present"}: <span style="color:#15803d">${present}</span></div>
    <div>${lang === "ar" ? "\u063A\u0627\u0626\u0628" : "Absent"}: <span style="color:#b91c1c">${absent}</span></div>
  </div>
  <table>
    ${WEEKLY_COLGROUP}
    <thead className="sticky top-0 z-30 bg-muted">
      <tr>
        <th>#</th>
        <th class="name-col">${L.workerName}</th>
        ${dayHeaders}
        <th>${L.notes}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="legend">
    <span><strong>${lang === "ar" ? "\u062D" : "P"}</strong> = ${lang === "ar" ? "\u062D\u0627\u0636\u0631" : "Present"}</span>
    <span><strong>${lang === "ar" ? "\u063A" : "A"}</strong> = ${lang === "ar" ? "\u063A\u0627\u0626\u0628" : "Absent"}</span>
  </div>
  <div class="footer">
    <div>${L.preparedBy}</div>
    <div>${L.supervisor}</div>
    <div>${L.approvedBy}</div>
  </div>
</body>
</html>`;
}

export async function exportRangeExcel(
  workers: WorkerRow[],
  attendance: AttendanceRecord[],
  dates: string[],
  startDate: string,
  endDate: string,
  lang: PrintLang
) {
  const wb = XLSX.utils.book_new();

  // Build lookup: workerId -> date -> status
  const lookup = new Map<number, Map<string, string>>();
  for (const r of attendance) {
    if (!lookup.has(r.workerId)) lookup.set(r.workerId, new Map());
    lookup.get(r.workerId)!.set(r.attendanceDate, r.status);
  }

  const activeWorkers = workers.filter((w) => w.active !== false);
  const inactiveWorkers = workers.filter((w) => w.active === false);

  const activeLabel = lang === "ar" ? "العمال النشطون" : "Active Workers";
  const inactiveLabel = lang === "ar" ? "العمال غير النشطين" : "Inactive Workers";

  const activeSheet = buildRangeSheet(activeWorkers, lookup, dates, startDate, endDate, lang, activeLabel, false);
  const inactiveSheet = buildRangeSheet(inactiveWorkers, lookup, dates, startDate, endDate, lang, inactiveLabel, true);

  XLSX.utils.book_append_sheet(wb, activeSheet, lang === "ar" ? "نشط" : "Active Workers");
  XLSX.utils.book_append_sheet(wb, inactiveSheet, lang === "ar" ? "غير نشط" : "Inactive Workers");

  styleFactoryOperationalWorkbook(wb, [
    { name: lang === "ar" ? "نشط" : "Active Workers", titleRow: 1, headerRow: 3 },
    { name: lang === "ar" ? "غير نشط" : "Inactive Workers", titleRow: 1, headerRow: 3 },
  ]);
  await XLSX.writeFile(wb, `attendance-range-${startDate}-to-${endDate}.xlsx`);
}

export function generateRangePrintHtml(
  workers: WorkerRow[],
  attendance: AttendanceRecord[],
  dates: string[],
  startDate: string,
  endDate: string,
  lang: PrintLang
) {
  const lookup = new Map<number, Map<string, string>>();
  for (const r of attendance) {
    if (!lookup.has(r.workerId)) lookup.set(r.workerId, new Map());
    lookup.get(r.workerId)!.set(r.attendanceDate, r.status);
  }

  const titleLabel = lang === "ar" ? "كشف الحضور" : "Attendance Sheet";
  const workerLabel = lang === "ar" ? "اسم العامل" : "Worker Name";
  const totalPLabel = lang === "ar" ? "حضور" : "P";
  const totalALabel = lang === "ar" ? "غياب" : "A";

  const dateHeaders = dates
    .map((d) => {
      const dt = new Date(d + "T00:00:00");
      const day = dt.getDate();
      const weekday = dt.toLocaleDateString(lang === "ar" ? "ar-SA" : "en-US", { weekday: "short" });
      const isFri = dt.getDay() === 5;
      const isSat = dt.getDay() === 6;
      const bg = isFri || isSat ? ' style="background:#f0f0f0"' : "";
      return `<th${bg}>${day}<br/><span style="font-size:6pt;color:#777">${weekday}</span></th>`;
    })
    .join("");

  const rows = workers
    .map((w, i) => {
      const wMap = lookup.get(w.id) ?? new Map();
      let presentCount = 0,
        absentCount = 0;
      const dayCells = dates
        .map((d) => {
          const dt = new Date(d + "T00:00:00");
          const isFri = dt.getDay() === 5;
          const isSat = dt.getDay() === 6;
          const status = wMap.get(d) ?? "Present";
          const mark = STATUS_MARKS[status] ?? escHtml(status.charAt(0));
          const color = STATUS_PRINT_COLORS[status] ?? "#374151";
          if (status === "Absent") absentCount++;
          else presentCount++;
          const bgStyle = isFri || isSat ? "background:#f7f7f7;" : "";
          return `<td class="day" style="${bgStyle}color:${color};font-weight:600">${mark}</td>`;
        })
        .join("");
      return `<tr>
      <td class="num">${i + 1}</td>
      <td class="name" dir="auto">${escHtml(w.fullName)}</td>
      ${dayCells}
      <td class="day" style="color:#15803d;font-weight:700">${presentCount}</td>
      <td class="day" style="color:#b91c1c;font-weight:700">${absentCount}</td>
    </tr>`;
    })
    .join("");

  const htmlLang = lang === "ar" ? "ar" : "en";
  const dateColWidth = Math.max(3, Math.floor(70 / dates.length));

  return `<!DOCTYPE html>
<html lang="${htmlLang}" dir="ltr">
<head>
  <meta charset="utf-8" />
  <title>${titleLabel}</title>
  <style>
    @page { size: A4 landscape; margin: 8mm 10mm; }
    * { box-sizing: border-box; }
    body { font-family: 'Segoe UI', Tahoma, Arial, 'Noto Sans Arabic', sans-serif; font-size: 7pt; color: #111; margin: 0; }
    h1 { font-size: 12pt; text-align: center; margin: 0 0 2px; }
    .subtitle { text-align: center; font-size: 8pt; color: #555; margin-bottom: 6px; }
    table { width: 100%; border-collapse: collapse; margin-top: 4px; table-layout: fixed; }
    th { background: #e8e8e8; border: 1px solid #aaa; padding: 2px 1px; font-size: 6.5pt; text-align: center; white-space: nowrap; overflow: hidden; }
    th.name-col { text-align: left; width: 18%; }
    th.num-col { width: 3%; }
    th.total-col { width: ${dateColWidth + 2}%; background: #dde8f0; }
    td { border: 1px solid #ccc; padding: 1px 2px; vertical-align: middle; height: 15px; }
    td.num { text-align: center; color: #888; width: 3%; }
    td.name { text-align: left; unicode-bidi: plaintext; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; width: 18%; }
    td.day { text-align: center; width: ${dateColWidth}%; }
    tr:nth-child(even) td { background: #f9f9f9; }
    .legend { margin-top: 5px; font-size: 6.5pt; color: #555; text-align: center; }
    .legend span { margin: 0 8px; }
    @media print { button { display: none; } }
  </style>
</head>
<body>
  <h1>${titleLabel}</h1>
  <div class="subtitle">${escHtml(startDate)} &ndash; ${escHtml(endDate)} &nbsp;|&nbsp; ${workers.length} ${lang === "ar" ? "عامل" : "workers"}</div>
  <table>
    <thead>
      <tr>
        <th class="num-col">#</th>
        <th class="name-col">${workerLabel}</th>
        ${dateHeaders}
        <th class="total-col">${totalPLabel}</th>
        <th class="total-col">${totalALabel}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="legend">
    <span><strong>&#10003;</strong> = ${lang === "ar" ? "حاضر" : "Present"}</span>
    <span><strong>&#10007;</strong> = ${lang === "ar" ? "غائب" : "Absent"}</span>
    <span><strong>L</strong> = ${lang === "ar" ? "متأخر" : "Late"}</span>
    <span><strong>&frac12;</strong> = ${lang === "ar" ? "نصف يوم" : "Half Day"}</span>
    <span><strong>&mdash;</strong> = ${lang === "ar" ? "إجازة" : "Leave"}</span>
  </div>
</body>
</html>`;
}

export function escHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
