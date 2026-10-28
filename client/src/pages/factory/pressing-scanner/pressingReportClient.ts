import * as XLSX from "@/lib/excelHelper";
import { PRESSING_TIME_ZONE } from "@shared/pressingTimeZone";
import {
  PRESSING_COLUMN_LABELS, type PressingReportColumn, type PressingReportFilters,
} from "@shared/pressingReportContracts";

export interface PressingDetailRow {
  id: number;
  referenceNumber: string;
  articleCode: string | null;
  productName: string | null;
  weightKg: string;
  machineId: number;
  machineName: string;
  operatorUserId: string;
  operatorName: string | null;
  shiftId: number | null;
  productionDate: string;
  confirmedAt: string;
  deviceCapturedAt: string | null;
  voidedAt: string | null;
  canReturn?: boolean;
  timezoneName: string;
  secondsSincePrevious: string | null;
}
export interface PressingCondensedRow {
  productionDate: string;
  machineId: number;
  machineName: string;
  operatorUserId: string;
  operatorName: string | null;
  shiftId: number | null;
  articleCode: string | null;
  productName: string | null;
  voided: boolean;
  timezoneName: string;
  bales: number;
  weightKg: string;
  firstScanAt: string;
  lastScanAt: string;
}
export interface PressingReportResponse {
  rows: Array<PressingDetailRow | PressingCondensedRow>;
  total: number;
  summary: { totalBales: number; totalKg: string; voidedBales: number;
    byOperator: Array<{ userId: string; name: string | null; totalBales: number; totalKg: string }> };
  overview: PressingReportResponse["summary"];
  page: number;
  limit: number;
  mode: "detailed" | "condensed";
  asOf: string;
}
export interface PressingSavedView {
  id: number;
  name: string;
  reportMode: "detailed" | "condensed";
  filters: Omit<PressingReportFilters, "asOf" | "mode" | "page" | "limit">;
  visibleColumns: PressingReportColumn[];
  isDefault: boolean;
}
export interface PressingReportOptions {
  canViewAll: boolean;
  serverToday: string;
  timeZone: string;
  machines: Array<{ id: number; code: string; name: string; active: boolean }>;
  operators: Array<{ userId: string; name: string; username?: string; isPressingWorker?: boolean }>;
  weightsKg: string[];
  canCorrect: boolean;
}
export function pressingParams(filters: PressingReportFilters): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== "") params.set(key, String(value));
  }
  return params;
}
export async function fetchPressingReport(filters: PressingReportFilters): Promise<PressingReportResponse> {
  const response = await fetch(
    "/api/factory/pressing-machines/report?" + pressingParams(filters).toString(),
    { credentials: "include", cache: "no-store" }
  );
  if (!response.ok) throw new Error("Could not load pressing history (" + response.status + ")");
  return response.json() as Promise<PressingReportResponse>;
}
export function pressingDisplayDateTime(time: string | null | undefined, _recordedTimeZone?: string) {
  if (!time) return "—";
  const date = new Date(time);
  if (!Number.isFinite(date.getTime())) return "—";
  // Even older confirmations recorded as UTC must display in Beirut.
  return date.toLocaleString("en-GB", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    timeZone: PRESSING_TIME_ZONE,
  });
}
export function pressingCell(
  row: PressingDetailRow | PressingCondensedRow, key: PressingReportColumn
): string | number {
  const detailed = "id" in row;
  switch (key) {
    case "referenceNumber": return detailed ? row.referenceNumber : "—";
    case "articleCode": return row.articleCode || "";
    case "productName": return row.productName || "";
    case "weightKg": return Number(row.weightKg);
    case "machineName": return row.machineName;
    case "operatorName": return row.operatorName || row.operatorUserId;
    case "shiftId": return row.shiftId ?? "—";
    case "productionDate": return row.productionDate.split("-").reverse().join("/");
    case "confirmedAt": return detailed ? pressingDisplayDateTime(row.confirmedAt, row.timezoneName) : "—";
    case "deviceCapturedAt": return detailed ? pressingDisplayDateTime(row.deviceCapturedAt) : "—";
    case "secondsSincePrevious": return detailed && row.secondsSincePrevious !== null
      ? Number(row.secondsSincePrevious) : "";
    case "status": return (detailed ? row.voidedAt !== null : row.voided) ? "Voided" : "Confirmed";
    case "bales": return detailed ? 1 : row.bales;
    case "firstScanAt": return detailed ? "" : pressingDisplayDateTime(row.firstScanAt, row.timezoneName);
    case "lastScanAt": return detailed ? "" : pressingDisplayDateTime(row.lastScanAt, row.timezoneName);
  }
}
// Excel formula injection protection for product and operator names.
function excelSafe(value: string | number): string | number {
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(value)) return "'" + value;
  return value;
}
export const PRESSING_EXPORT_LIMIT = 30000;
export async function exportPressingReport(
  filters: PressingReportFilters, columns: PressingReportColumn[],
  onProgress?: (text: string) => void
): Promise<void> {
  // Use a fixed server-returned asOf cutoff on every subsequent page.
  const first = await fetchPressingReport({ ...filters, asOf: undefined, page: 1, limit: 250 });
  if (first.total > PRESSING_EXPORT_LIMIT) {
    throw new Error("The report has " + first.total.toLocaleString() +
      " groups/rows. Narrow your dates or filters to export at most " +
      PRESSING_EXPORT_LIMIT.toLocaleString() + " at once.");
  }
  const all = [...first.rows];
  const pages = Math.ceil(first.total / 250);
  for (let page = 2; page <= pages; page++) {
    onProgress?.("Downloading page " + page + " of " + pages);
    const result = await fetchPressingReport({ ...filters, asOf: first.asOf, page, limit: 250 });
    all.push(...result.rows);
  }
  // Never silently distribute a partial workbook.
  if (all.length !== first.total) throw new Error(
    "Pressing records changed during export; refresh and try again."
  );
  const wb = XLSX.utils.book_new();
  const ws = wb.addWorksheet(filters.mode === "condensed" ? "Daily Summary" : "Detailed History");
  const safeColumnCount = Math.max(1, columns.length);
  ws.mergeCells(1, 1, 1, safeColumnCount);
  ws.getCell(1, 1).value = "PRESSING MACHINES — " + filters.mode.toUpperCase() + " HISTORY";
  ws.getCell(1, 1).font = { bold: true, size: 15, color: { argb: "FFFFFFFF" } };
  ws.getCell(1, 1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF182638" } };
  ws.getRow(1).height = 28;
  ws.mergeCells(2, 1, 2, safeColumnCount);
  ws.getCell(2, 1).value = "Period: " + (filters.from || "All time") + " to " +
    (filters.to || "All time") + " | As of " + pressingDisplayDateTime(first.asOf);
  ws.mergeCells(3, 1, 3, safeColumnCount);
  ws.getCell(3, 1).value = "Accepted bales: " + first.summary.totalBales +
    " | Accepted KG: " + first.summary.totalKg + " | Voided: " + first.summary.voidedBales;
  const head = ws.addRow(columns.map(key => PRESSING_COLUMN_LABELS[key]));
  head.eachCell(cell => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF27394E" } };
    cell.border = { bottom: { style: "medium" }, top: { style: "medium" },
      left: { style: "medium" }, right: { style: "medium" } };
  });
  for (const [index, item] of all.entries()) {
    const row = ws.addRow(columns.map(key => excelSafe(pressingCell(item, key))));
    row.eachCell(cell => {
      cell.border = { bottom: { style: "thin" }, top: { style: "thin" },
        left: { style: "thin" }, right: { style: "thin" } };
      if (index % 2) cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F3F6" } };
    });
  }
  const totalRow = ws.addRow(columns.map(key => key === "weightKg"
    ? Number(first.summary.totalKg)
    : key === "bales" ? first.summary.totalBales : key === columns[0] ? "TOTAL ACTIVE" : ""));
  totalRow.eachCell(cell => {
    cell.font = { bold: true };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE4ED" } };
    cell.border = { top: { style: "medium" }, bottom: { style: "medium" } };
  });
  ws.columns.forEach((column, index) => {
    column.width = Math.min(40, Math.max(14, (PRESSING_COLUMN_LABELS[columns[index]] || "").length + 5));
  });
  ws.views = [{ state: "frozen", ySplit: 4 }];
  if (all.length) ws.autoFilter = { from: { row: 4, column: 1 },
    to: { row: 4 + all.length, column: safeColumnCount } };
  const stamp = (filters.from || "all-time") + "_" + (filters.to || "all-time");
  onProgress?.("Preparing Excel workbook");
  await XLSX.writeFile(wb, "pressing-machines-" + filters.mode + "-" + stamp + ".xlsx");
}
