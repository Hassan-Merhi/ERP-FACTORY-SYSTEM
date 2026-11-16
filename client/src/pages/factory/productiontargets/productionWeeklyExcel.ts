import type ExcelJS from "exceljs";
import { fetchProduction } from "../factoryProductionTargetsModel";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import {
  INK,
  NAVY,
  WHITE,
  buildWeeklyProductionData,
  getProductionRangeDates,
  prepareSheet,
  type ProductionReportDay,
} from "./buildWeeklyProductionData";
export {
  ProductionDateRangeError,
  buildWeeklyProductionData,
  factoryProductionToday,
  getProductionRangeDates,
  splitTeamBales,
} from "./buildWeeklyProductionData";
export type { DailyTeamRecord, ProductionReportDay, WorkerDayRecord } from "./buildWeeklyProductionData";
const PALE = "FFF1F5F9";
const GREEN = "FF047857";
const RED = "FFB91C1C";

function appendBody(
  sheet: ExcelJS.Worksheet,
  values: Array<string | number | null>,
  differenceColumn?: number,
  statusColumn?: number
): void {
  const row = sheet.addRow(values.map((value) => value ?? ""));
  row.height = 23;
  const alternating = row.number % 2 === 0;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = { name: "Aptos", size: 10, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: alternating ? WHITE : PALE } };
    cell.alignment = { vertical: "middle", wrapText: col === 3 || col === 4 || col === 11 };
    cell.border = { bottom: { style: "hair", color: { argb: "FFDCE3ED" } } };
    if (typeof cell.value === "number") cell.numFmt = "0";
  });
  if (differenceColumn) {
    const cell = row.getCell(differenceColumn);
    if (typeof cell.value === "number") {
      cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: cell.value < 0 ? RED : GREEN } };
      cell.numFmt = "+0;-0;0";
    }
  }
  if (statusColumn) {
    const cell = row.getCell(statusColumn);
    if (cell.value === "Open / live") {
      cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: RED } };
    }
  }
}

function enableFilter(sheet: ExcelJS.Worksheet, lastCol: number, lastDataRow: number) {
  if (lastDataRow >= 6) {
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: lastDataRow, column: lastCol } };
  }
  sheet.pageSetup.printTitlesRow = "1:5";
}

function addNote(sheet: ExcelJS.Worksheet, note: string, lastCol: number) {
  const rowIndex = sheet.rowCount + 2;
  sheet.mergeCells(rowIndex, 1, rowIndex, lastCol);
  const cell = sheet.getCell(rowIndex, 1);
  cell.value = note;
  cell.font = { name: "Aptos", size: 10, italic: true, color: { argb: INK } };
  cell.alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(rowIndex).height = 46;
}

function createWorkbook(
  data: ReturnType<typeof buildWeeklyProductionData>,
  start: string,
  end: string,
  WorkbookCtor: new () => ExcelJS.Workbook
) {
  const book = new WorkbookCtor();
  book.creator = "Factory Production Targets";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const suffix = "Selected dates " + start + " to " + end;

  // Put the per-worker totals first: this is the primary purpose of the export.
  const workerSheet = book.addWorksheet("Worker Totals");
  const overview = book.addWorksheet("Period Overview");
  prepareSheet(
    overview,
    "WEEKLY PRODUCTION | OVERVIEW",
    suffix,
    ["Date", "Day", "Workers", "Absent", "Target", "Absent Target", "Expected", "Produced", "Difference", "Day Status"],
    [16, 16, 12, 12, 15, 17, 15, 15, 17, 18]
  );
  for (const day of data.summary) {
    const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(
      new Date(day.date + "T12:00:00Z")
    );
    appendBody(
      overview,
      [
        day.date,
        dayName,
        day.workers,
        day.absent,
        day.target,
        day.absentTarget,
        day.expected,
        day.produced,
        day.difference,
        day.status,
      ],
      9,
      10
    );
  }
  const lastDailyRow = overview.rowCount;
  enableFilter(overview, 10, lastDailyRow);
  const total = overview.addRow([
    "PERIOD TOTAL",
    "",
    "",
    "",
    data.summary.reduce((sum, day) => sum + day.target, 0),
    data.summary.reduce((sum, day) => sum + day.absentTarget, 0),
    data.summary.reduce((sum, day) => sum + day.expected, 0),
    data.summary.reduce((sum, day) => sum + day.produced, 0),
    data.summary.reduce((sum, day) => sum + day.difference, 0),
    "",
  ]);
  total.height = 29;
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Aptos", bold: true, size: 11, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    if (typeof cell.value === "number") cell.numFmt = "0";
  });
  addNote(
    overview,
    "Each date is calculated independently. Linked teams count production ONCE. Open days are live and may change; finalized days use saved daily production.",
    10
  );

  const teamSheet = book.addWorksheet("Daily Teams");
  prepareSheet(
    teamSheet,
    "DAILY PRODUCTION | UNIQUE TEAMS",
    suffix,
    [
      "Date",
      "Category",
      "Worker(s)",
      "Code(s)",
      "Link On Date",
      "Target",
      "Absent Target",
      "Expected",
      "Produced",
      "Difference",
      "Attendance",
      "Credited to Workers",
      "Day Status",
    ],
    [16, 22, 45, 21, 20, 14, 16, 14, 15, 16, 48, 48, 18]
  );
  for (const t of data.teams) {
    appendBody(
      teamSheet,
      [
        t.date,
        t.category,
        t.people,
        t.codes,
        t.team,
        t.target,
        t.absentTarget,
        t.expected,
        t.produced,
        t.difference,
        t.attendance,
        t.creditedBreakdown,
        t.dayStatus,
      ],
      10,
      13
    );
  }
  enableFilter(teamSheet, 13, teamSheet.rowCount);
  addNote(
    teamSheet,
    "One row represents one individual or linked production team on that date. Credited shares add up to team production exactly; odd remaining bales go by worker ID order.",
    13
  );

  const historySheet = book.addWorksheet("Worker Daily History");
  prepareSheet(
    historySheet,
    "WORKER ASSIGNMENTS | DAY BY DAY",
    suffix,
    [
      "Date",
      "Worker",
      "Code",
      "Category",
      "Linked With That Day",
      "Link On Date",
      "Individual Target",
      "Attendance",
      "Solo Produced",
      "Linked Credit",
      "Total Produced",
      "Shared Team Reference*",
      "Day Status",
    ],
    [16, 29, 17, 24, 42, 19, 19, 17, 18, 18, 19, 24, 18]
  );
  for (const h of data.history) {
    appendBody(
      historySheet,
      [
        h.date,
        h.name,
        h.code,
        h.category,
        h.linkedWith,
        h.team,
        h.target,
        h.status,
        h.soloProduced,
        h.linkedProduced,
        h.totalProduced,
        h.sharedTeamProduced,
        h.dayStatus,
      ],
      undefined,
      13
    );
  }
  enableFilter(historySheet, 13, historySheet.rowCount);
  addNote(
    historySheet,
    "*Shared Team Reference repeats the team total and must NOT be added. Solo Produced + Linked Credit = Total Produced for each worker on each date.",
    13
  );

  prepareSheet(
    workerSheet,
    "WORKER TOTAL BALES | SELECTED DATES",
    suffix,
    [
      "Worker",
      "Code",
      "Days",
      "Present / New",
      "Absent",
      "Target",
      "Absent Target",
      "Expected",
      "Unlinked Bales",
      "Linked Bales Credit",
      "TOTAL PRODUCED",
      "Linked Days",
    ],
    [30, 18, 12, 17, 13, 16, 17, 16, 19, 21, 21, 15]
  );
  for (const w of data.workers) {
    appendBody(workerSheet, [
      w.name,
      w.code,
      w.days,
      w.present,
      w.absent,
      w.target,
      w.absentTarget,
      w.expected,
      w.soloProduced,
      w.linkedProduced,
      w.totalProduced,
      w.linkedDays,
    ]);
    const cell = workerSheet.getRow(workerSheet.rowCount).getCell(11);
    cell.font = { name: "Aptos", size: 11, bold: true, color: { argb: GREEN } };
  }
  enableFilter(workerSheet, 12, workerSheet.rowCount);
  const workerTotal = workerSheet.addRow([
    "ALL WORKERS",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    data.workers.reduce((sum, worker) => sum + worker.soloProduced, 0),
    data.workers.reduce((sum, worker) => sum + worker.linkedProduced, 0),
    data.workers.reduce((sum, worker) => sum + worker.totalProduced, 0),
    "",
  ]);
  workerTotal.height = 28;
  workerTotal.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Aptos", bold: true, size: 11, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    if (typeof cell.value === "number") cell.numFmt = "0";
  });
  addNote(
    workerSheet,
    "TOTAL PRODUCED = bales finalized under the worker on unlinked days + an equal whole-bale share of each linked team's output on that date. Team production is never counted twice. For odd totals, remaining bales go to the lowest worker ID; absent workers are excluded when another member is present.",
    12
  );
  return book;
}

export async function exportWeeklyProductionExcel(
  start: string,
  end: string
): Promise<{ start: string; end: string; through: string }> {
  const dates = getProductionRangeDates(start, end);

  // Two daily requests at a time keeps larger date ranges from overwhelming the factory API.
  const days: ProductionReportDay[] = [];
  for (let i = 0; i < dates.length; i += 2) {
    const batch = await Promise.all(
      dates.slice(i, i + 2).map(async (date) => ({
        date,
        snapshot: await fetchProduction("daily", date, date),
      }))
    );
    days.push(...batch);
  }

  const data = buildWeeklyProductionData(days);
  const excelModule = await import("exceljs");
  const runtime = excelModule.default ?? excelModule;
  const workbook = createWorkbook(data, start, end, runtime.Workbook);
  const raw = await workbook.xlsx.writeBuffer();
  const blob = new Blob([raw], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  downloadBlob(blob, exportFileName("production targets", "xlsx", { from: start, to: end }));
  return { start, end, through: end };
}
