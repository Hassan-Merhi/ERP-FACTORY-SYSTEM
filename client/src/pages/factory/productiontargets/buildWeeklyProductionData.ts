// Extracted from ./productionWeeklyExcel.ts to keep that module under the source-size cap.
import type ExcelJS from "exceljs";
import { isProductionWorkday } from "@shared/productionTargetBonusWeeklyMethod";
import {
  addIsoDays,
  collapseLinkedProductionRows,
  localDateStr,
  parseLocalDate,
  type ProductionResponse,
  type ProductionRow,
  summarizeProductionRows,
} from "../factoryProductionTargetsModel";

export class ProductionDateRangeError extends Error {
  constructor(public readonly code: "invalid" | "future" | "tooLong") {
    super(code);
    this.name = "ProductionDateRangeError";
  }
}

export function getProductionRangeDates(
  start: string,
  end: string,
  today: string = factoryProductionToday()
): string[] {
  const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && localDateStr(parseLocalDate(value)) === value;
  if (!isDate(start) || !isDate(end) || start > end) throw new ProductionDateRangeError("invalid");
  if (end > today) throw new ProductionDateRangeError("future");

  const dates: string[] = [];
  let calendarDays = 0;
  for (let date = start; date <= end; date = addIsoDays(date, 1)) {
    // The export limit remains twelve CALENDAR weeks; Sunday is skipped, not charged.
    if (++calendarDays > 84) throw new ProductionDateRangeError("tooLong");
    if (isProductionWorkday(date)) dates.push(date);
  }
  if (!dates.length) throw new ProductionDateRangeError("invalid");
  return dates;
}

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
  creditedBreakdown: string;
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
  soloProduced: number;
  linkedProduced: number;
  totalProduced: number;
  sharedTeamProduced: number | null;
  dayStatus: string;
}

export function splitTeamBales(
  producedBales: number,
  members: Array<Pick<ProductionRow, "personId" | "status">>
): Map<number, number> {
  // A bale is indivisible. Keep the exact team count by allocating any
  // remainder in stable worker-ID order, never assigning 7.5 physical bales.
  // Absent workers are excluded when at least one member is present.
  const eligible = members.filter((member) => member.status !== "Absent");
  const recipients = (eligible.length ? eligible : members)
    .slice()
    .sort((left, right) => left.personId - right.personId);
  const shares = new Map(members.map((member) => [member.personId, 0]));
  if (!recipients.length) return shares;
  const quantity = Math.max(0, Math.round(producedBales));
  const base = Math.floor(quantity / recipients.length);
  const extra = quantity % recipients.length;
  recipients.forEach((member, index) => {
    shares.set(member.personId, base + (index < extra ? 1 : 0));
  });
  return shares;
}

export function buildWeeklyProductionData(days: ProductionReportDay[]) {
  const summary = [];
  const teams: DailyTeamRecord[] = [];
  const history: WorkerDayRecord[] = [];
  const workerTotals = new Map<
    number,
    {
      workerId: number;
      name: string;
      code: string;
      days: number;
      present: number;
      absent: number;
      target: number;
      absentTarget: number;
      expected: number;
      soloProduced: number;
      linkedProduced: number;
      totalProduced: number;
      linkedDays: number;
    }
  >();

  for (const { date, snapshot } of [...days].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!isProductionWorkday(date)) continue;
    const totals = summarizeProductionRows(snapshot.rows);
    const absentCount = snapshot.rows.filter((row) => row.status === "Absent").length;
    const dayStatus = snapshot.finalized ? "Finalized" : "Open / live";
    summary.push({
      date,
      workers: snapshot.rows.length,
      absent: absentCount,
      status: dayStatus,
      ...totals,
    });

    // Rebuild links from EACH day's date-effective API result, not the current
    // on-screen state. A team gets one produced count, never one per member.
    const memberRows = new Map<number, ProductionRow[]>();
    const linkedCredits = new Map<number, number>();
    for (const row of snapshot.rows) {
      if (row.linkGroupId == null) continue;
      const group = memberRows.get(row.linkGroupId) ?? [];
      group.push(row);
      memberRows.set(row.linkGroupId, group);
    }

    for (const group of collapseLinkedProductionRows(snapshot.rows)) {
      const members = group.linkGroupId == null ? [group] : (memberRows.get(group.linkGroupId) ?? [group]);
      const targetValues = members.map((member) => member.targetBales);
      const target = targetValues.every((value) => value == null)
        ? null
        : targetValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
      const absentTarget = members.reduce(
        (sum, member) => sum + (member.status === "Absent" ? (member.targetBales ?? 0) : 0),
        0
      );
      const expected = (target ?? 0) - absentTarget;
      const produced = group.producedBales ?? 0;
      const credited =
        group.linkGroupId == null ? new Map([[group.personId, produced]]) : splitTeamBales(produced, members);
      if (group.linkGroupId != null) {
        for (const [workerId, share] of credited) linkedCredits.set(workerId, share);
      }
      teams.push({
        date,
        category: group.category || "Uncategorized",
        people: members.map((member) => member.name).join(" + "),
        codes: members
          .map((member) => member.code || "")
          .filter(Boolean)
          .join(" + "),
        team: group.linkGroupId == null ? "Individual" : "Linked #" + group.linkGroupId,
        target,
        absentTarget,
        expected,
        produced,
        difference: produced - expected,
        attendance: members.map((member) => member.name + ": " + member.status).join("; "),
        creditedBreakdown: members
          .map((member) => member.name + ": " + (credited.get(member.personId) ?? 0))
          .join("; "),
        dayStatus,
      });
    }

    for (const row of snapshot.rows) {
      const linkMembers = row.linkGroupId == null ? [] : (memberRows.get(row.linkGroupId) ?? [row]);
      const partners = linkMembers.filter((member) => member.personId !== row.personId);
      const soloProduced = row.linkGroupId == null ? (row.producedBales ?? 0) : 0;
      const linkedProduced = linkedCredits.get(row.personId) ?? 0;
      const totalProduced = soloProduced + linkedProduced;
      history.push({
        date,
        workerId: row.personId,
        name: row.name,
        code: row.code || "",
        category: row.category || "Uncategorized",
        linkedWith: partners.map((member) => member.name).join(" + "),
        team: row.linkGroupId == null ? "Individual" : "Linked #" + row.linkGroupId,
        target: row.targetBales,
        status: row.status,
        soloProduced,
        linkedProduced,
        totalProduced,
        // This is shown as a REFERENCE only and is never totaled per worker.
        sharedTeamProduced: row.linkGroupId == null ? null : (row.producedBales ?? 0),
        dayStatus,
      });
      const stats = workerTotals.get(row.personId) ?? {
        workerId: row.personId,
        name: row.name,
        code: row.code || "",
        days: 0,
        present: 0,
        absent: 0,
        target: 0,
        absentTarget: 0,
        expected: 0,
        soloProduced: 0,
        linkedProduced: 0,
        totalProduced: 0,
        linkedDays: 0,
      };
      const assignedTarget = row.targetBales ?? 0;
      stats.days += 1;
      stats.present += row.status === "Absent" ? 0 : 1;
      stats.absent += row.status === "Absent" ? 1 : 0;
      stats.target += assignedTarget;
      stats.absentTarget += row.status === "Absent" ? assignedTarget : 0;
      stats.expected += row.status === "Absent" ? 0 : assignedTarget;
      stats.soloProduced += soloProduced;
      stats.linkedProduced += linkedProduced;
      stats.totalProduced += totalProduced;
      stats.linkedDays += row.linkGroupId == null ? 0 : 1;
      workerTotals.set(row.personId, stats);
    }
  }

  teams.sort(
    (a, b) => a.date.localeCompare(b.date) || a.category.localeCompare(b.category) || a.people.localeCompare(b.people)
  );
  history.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  return {
    summary,
    teams,
    history,
    workers: [...workerTotals.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export function factoryProductionToday(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "";
  return part("year") + "-" + part("month") + "-" + part("day");
}

export const INK = "FF172337";

export const NAVY = "FF183153";

export const WHITE = "FFFFFFFF";

export function prepareSheet(
  sheet: ExcelJS.Worksheet,
  heading: string,
  subtitle: string,
  headers: string[],
  widths: number[]
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
  widths.forEach((width, idx) => {
    sheet.getColumn(idx + 1).width = width;
  });
  sheet.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
  sheet.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 },
  };
  sheet.headerFooter.oddFooter = "Factory Production Targets | Page &P of &N";
}
