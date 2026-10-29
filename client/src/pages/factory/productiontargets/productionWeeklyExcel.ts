import type ExcelJS from "exceljs";
import {
  addIsoDays,
  collapseLinkedProductionRows,
  fetchProduction,
  periodFor,
  summarizeProductionRows,
  type ProductionResponse,
  type ProductionRow,
} from "../factoryProductionTargetsModel";

export interface ProductionReportDay {
  date: string;
  snapshot: ProductionResponse;
}

export interface DailyTeamRecord {
  date: string;
  category: string;
  people: string;
  codes: string;
  team: string;
  target: number | null;
  absentTarget: number;
  expected: number;
  produced: number;
  difference: number;
  attendance: string;
  dayStatus: string;
}

export interface WorkerDayRecord {
  date: string;
  workerId: number;
  name: string;
  code: string;
  category: string;
  linkedWith: string;
  team: string;
  target: number | null;
  status: string;
  soloProduced: number | null;
  sharedTeamProduced: number | null;
  dayStatus: string;
}

export function buildWeeklyProductionData(days: ProductionReportDay[]) {
  const summary = [];
  const teams: DailyTeamRecord[] = [];
  const history: WorkerDayRecord[] = [];
  const workerTotals = new Map<number, {
    workerId: number; name: string; code: string;
    days: number; present: number; absent: number;
    target: number; absentTarget: number; expected: number;
    soloProduced: number; linkedDays: number;
  }>();

  for (const { date, snapshot } of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    const totals = summarizeProductionRows(snapshot.rows);
    const absentCount = snapshot.rows.filter((row) => row.status === "Absent").length;
    const dayStatus = snapshot.finalized ? "Finalized" : "Open / live";
    summary.push({
      date, workers: snapshot.rows.length, absent: absentCount, status: dayStatus,
      ...totals,
    });

    // Rebuild links from EACH day's date-effective API result, not the current
    // on-screen state. A team gets one produced count, never one per member.
    const memberRows = new Map<number, ProductionRow[]>();
    for (const row of snapshot.rows) {
      if (row.linkGroupId == null) continue;
      const group = memberRows.get(row.linkGroupId) ?? [];
      group.push(row);
      memberRows.set(row.linkGroupId, group);
    }

    for (const group of collapseLinkedProductionRows(snapshot.rows)) {
      const members = group.linkGroupId == null
        ? [group]
        : memberRows.get(group.linkGroupId) ?? [group];
      const targetValues = members.map((member) => member.targetBales);
      const target = targetValues.every((value) => value == null)
        ? null
        : targetValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      const absentTarget = members.reduce(
        (sum, member) => sum + (member.status === "Absent" ? member.targetBales ?? 0 : 0), 0
      );
      const expected = (target ?? 0) - absentTarget;
      const produced = group.producedBales ?? 0;
      teams.push({
        date,
        category: group.category || "Uncategorized",
        people: members.map((member) => member.name).join(" + "),
        codes: members.map((member) => member.code || "").filter(Boolean).join(" + "),
        team: group.linkGroupId == null ? "Individual" : "Linked #" + group.linkGroupId,
        target,
        absentTarget,
        expected,
        produced,
        difference: produced - expected,
        attendance: members.map((member) => member.name + ": " + member.status).join("; "),
        dayStatus,
      });
    }

    for (const row of snapshot.rows) {
      const linkMembers = row.linkGroupId == null ? [] : memberRows.get(row.linkGroupId) ?? [row];
      const partners = linkMembers.filter((member) => member.personId !== row.personId);
      history.push({
        date, workerId: row.personId, name: row.name, code: row.code || "",
        category: row.category || "Uncategorized",
        linkedWith: partners.map((member) => member.name).join(" + "),
        team: row.linkGroupId == null ? "Individual" : "Linked #" + row.linkGroupId,
        target: row.targetBales,
        status: row.status,
        soloProduced: row.linkGroupId == null ? row.producedBales ?? 0 : null,
        // This is shown as a REFERENCE only and is never totaled per worker.
        sharedTeamProduced: row.linkGroupId == null ? null : row.producedBales ?? 0,
        dayStatus,
      });
      const stats = workerTotals.get(row.personId) ?? {
        workerId: row.personId, name: row.name, code: row.code || "",
        days: 0, present: 0, absent: 0, target: 0, absentTarget: 0,
        expected: 0, soloProduced: 0, linkedDays: 0,
      };
      const assignedTarget = row.targetBales ?? 0;
      stats.days += 1;
      stats.present += row.status === "Absent" ? 0 : 1;
      stats.absent += row.status === "Absent" ? 1 : 0;
      stats.target += assignedTarget;
      stats.absentTarget += row.status === "Absent" ? assignedTarget : 0;
      stats.expected += row.status === "Absent" ? 0 : assignedTarget;
      stats.soloProduced += row.linkGroupId == null ? row.producedBales ?? 0 : 0;
      stats.linkedDays += row.linkGroupId == null ? 0 : 1;
      workerTotals.set(row.personId, stats);
    }
  }

  teams.sort((a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category) || a.people.localeCompare(b.people));
  history.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    summary, teams, history,
    workers: [...workerTotals.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function factoryToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

const INK = "FF172337";
const NAVY = "FF183153";
const BLUE = "FF2563EB";
const WHITE = "FFFFFFFF";
const PALE = "FFF1F5F9";
const GREEN = "FF047857";
const RED = "FFB91C1C";

function prepareSheet(
  sheet: ExcelJS.Worksheet,
  heading: string,
  subtitle: string,
  headers: string[],
  widths: number[],
): void {
  const lastCol = headers.length;
  sheet.mergeCells(1, 1, 2, lastCol);
  sheet.getCell(1, 1).value = heading;
  sheet.getCell(1, 1).font = { name: "Aptos Display", size: 18, bold: true, color: { argb: WHITE } };
  sheet.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  sheet.getCell(1, 1).alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 25;
  sheet.getRow(2).height = 20;

  sheet.mergeCells(3, 1, 3, lastCol);
  sheet.getCell(3, 1).value = subtitle;
  sheet.getCell(3, 1).font = { name: "Aptos", size: 11, color: { argb: INK } };
  sheet.getCell(3, 1).alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(3).height = 25;
  sheet.getRow(4).height = 12;

  const header = sheet.getRow(5);
  header.values = headers;
  header.height = 32;
  header.eachCell((cell) => {
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  });
  widths.forEach((width, idx) => { sheet.getColumn(idx + 1).width = width; });
  sheet.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
  sheet.pageSetup = {
    paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
  };
  sheet.headerFooter.oddFooter = "Factory Production Targets | Page &P of &N";
}

function appendBody(
  sheet: ExcelJS.Worksheet,
  values: Array<string | number | null>,
  differenceColumn?: number,
  statusColumn?: number,
): void {
  const row = sheet.addRow(values.map((value) => value ?? ""));
  row.height = 23;
  const alternating = row.number % 2 === 0;
  row.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.font = { name: "Aptos", size: 10, color: { argb: INK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: alternating ? WHITE : PALE } };
    cell.alignment = { vertical: "middle", wrapText: col === 3 || col === 4 || col === 11 };
    cell.border = { bottom: { style: "hair", color: { argb: "FFDCE3ED" } } };
    if (typeof cell.value === "number") cell.numFmt = "#,##0.##";
  });
  if (differenceColumn) {
    const cell = row.getCell(differenceColumn);
    if (typeof cell.value === "number") {
      cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: cell.value < 0 ? RED : GREEN } };
      cell.numFmt = '+#,##0.##;-#,##0.##;0';
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
  sheet.getRow(rowIndex).height = 35;
}

function createWorkbook(
  data: ReturnType<typeof buildWeeklyProductionData>,
  start: string,
  end: string,
  through: string,
  ExcelRuntime: typeof ExcelJS,
) {
  const book = new ExcelRuntime.Workbook();
  book.creator = "Factory Production Targets";
  book.created = new Date();
  book.calcProperties.fullCalcOnLoad = true;
  const suffix = "Week " + start + " to " + end + (through < end ? " (through " + through + ")" : "");

  const overview = book.addWorksheet("Weekly Overview");
  prepareSheet(overview, "WEEKLY PRODUCTION | OVERVIEW", suffix,
    ["Date", "Day", "Workers", "Absent", "Target", "Absent Target", "Expected", "Produced", "Difference", "Day Status"],
    [16, 16, 12, 12, 15, 17, 15, 15, 17, 18]);
  for (const day of data.summary) {
    const dayName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long" }).format(new Date(day.date + "T12:00:00Z"));
    appendBody(overview, [
      day.date, dayName, day.workers, day.absent, day.target,
      day.absentTarget, day.expected, day.produced, day.difference, day.status,
    ], 9, 10);
  }
  const lastDailyRow = overview.rowCount;
  enableFilter(overview, 10, lastDailyRow);
  const total = overview.addRow(["WEEK TOTAL", "", "", "",
    data.summary.reduce((sum, day) => sum + day.target, 0),
    data.summary.reduce((sum, day) => sum + day.absentTarget, 0),
    data.summary.reduce((sum, day) => sum + day.expected, 0),
    data.summary.reduce((sum, day) => sum + day.produced, 0),
    data.summary.reduce((sum, day) => sum + day.difference, 0), ""]);
  total.height = 29;
  total.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { name: "Aptos", bold: true, size: 11, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    if (typeof cell.value === "number") cell.numFmt = "#,##0.##";
  });
  addNote(overview, "Each date is calculated independently. Linked teams count production ONCE. Open days are live and may change; finalized days use saved daily production.", 10);

  const teamSheet = book.addWorksheet("Daily Teams");
  prepareSheet(teamSheet, "DAILY PRODUCTION | UNIQUE TEAMS", suffix,
    ["Date", "Category", "Worker(s)", "Code(s)", "Link On Date", "Target", "Absent Target", "Expected", "Produced", "Difference", "Attendance", "Day Status"],
    [16, 22, 45, 21, 20, 14, 16, 14, 15, 16, 48, 18]);
  for (const t of data.teams) {
    appendBody(teamSheet, [t.date, t.category, t.people, t.codes, t.team,
      t.target, t.absentTarget, t.expected, t.produced, t.difference, t.attendance, t.dayStatus], 10, 12);
  }
  enableFilter(teamSheet, 12, teamSheet.rowCount);
  addNote(teamSheet, "One row represents one individual or linked production team on that date. Produced is never repeated per linked member.", 12);

  const historySheet = book.addWorksheet("Worker Daily History");
  prepareSheet(historySheet, "WORKER ASSIGNMENTS | DAY BY DAY", suffix,
    ["Date", "Worker", "Code", "Category", "Linked With That Day", "Link On Date", "Individual Target", "Attendance", "Solo Produced", "Shared Team Produced*", "Day Status"],
    [16, 29, 17, 24, 42, 19, 19, 17, 18, 24, 18]);
  for (const h of data.history) {
    appendBody(historySheet, [h.date, h.name, h.code, h.category, h.linkedWith,
      h.team, h.target, h.status, h.soloProduced, h.sharedTeamProduced, h.dayStatus], undefined, 11);
  }
  enableFilter(historySheet, 11, historySheet.rowCount);
  addNote(historySheet, "*Shared Team Produced repeats the SAME team total for reference on each linked member. DO NOT sum this column. Use Daily Teams for accurate production totals.", 11);

  const workerSheet = book.addWorksheet("Worker Weekly Targets");
  prepareSheet(workerSheet, "WORKER TARGETS | WEEKLY", suffix,
    ["Worker", "Code", "Days", "Present / New", "Absent", "Target", "Absent Target", "Expected", "Solo Produced*", "Linked Days"],
    [30, 18, 12, 17, 13, 16, 17, 16, 19, 15]);
  for (const w of data.workers) {
    appendBody(workerSheet, [w.name, w.code, w.days, w.present, w.absent,
      w.target, w.absentTarget, w.expected, w.soloProduced, w.linkedDays]);
  }
  enableFilter(workerSheet, 10, workerSheet.rowCount);
  addNote(workerSheet, "*Solo Produced excludes shared team production. Linked days are shown separately to avoid incorrectly crediting the full team output to each person. See Daily Teams.", 10);
  return book;
}

export async function exportWeeklyProductionExcel(referenceDate: string): Promise<{ start: string; end: string; through: string }> {
  const { start, end } = periodFor("weekly", referenceDate);
  const today = factoryToday();
  if (start > today) throw new Error("A future production week cannot be exported yet.");
  const through = end < today ? end : today;
  const dates: string[] = [];
  for (let date = start; date <= through; date = addIsoDays(date, 1)) dates.push(date);

  // Two requests at a time avoid a seven-request burst against factory production.
  const days: ProductionReportDay[] = [];
  for (let i = 0; i < dates.length; i += 2) {
    const batch = await Promise.all(dates.slice(i, i + 2).map(async (date) => ({
      date, snapshot: await fetchProduction("daily", date, date),
    })));
    days.push(...batch);
  }
  const data = buildWeeklyProductionData(days);
  const excelModule = await import("exceljs");
  const runtime = excelModule.default ?? excelModule;
  const workbook = createWorkbook(data, start, end, through, runtime);
  const raw = await workbook.xlsx.writeBuffer();
  const blob = new Blob([raw], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = "Production_Targets_Weekly_" + start + "_to_" + through + ".xlsx";
    document.body.appendChild(link);
    link.click();
    link.remove();
  } finally {
    // Delay revocation until the browser has accepted the download.
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
  return { start, end, through };
}
