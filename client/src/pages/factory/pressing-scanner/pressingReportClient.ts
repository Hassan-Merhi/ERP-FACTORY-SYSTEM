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
  operators: Array<{ userId: string; name: string; displayName?: string | null; username?: string; isPressingWorker?: boolean }>;
  weightsKg: string[];
  canCorrect: boolean;
}
/**
 * P1/P2/P3 are account identifiers, never the KPI labels. Show the current
 * company-scoped Factory display name and attach totals by stable user ID.
 * Operators with no confirmations still appear with zero bales and KG.
 */
export function pressingKpiWorkers(
  operators: PressingReportOptions["operators"],
  byOperator: PressingReportResponse["summary"]["byOperator"],
) {
  return (["P1", "P2", "P3"] as const).map((slot, index) => {
    const operator = operators.find(item =>
      item.isPressingWorker === true && item.username?.trim().toUpperCase() === slot
    );
    const workerTotals = byOperator.find(item => item.userId === operator?.userId);
    return {
      slot,
      label: operator?.displayName?.trim() || `Worker ${index + 1} (display name not set)`,
      userId: operator?.userId,
      bales: Number(workerTotals?.totalBales || 0),
      kg: Number(workerTotals?.totalKg || 0),
    };
  });
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
    case "operatorName": return row.operatorName?.trim() || "Display name not set";
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
  if (columns.length === 0) throw new Error("Select at least one pressing report column");
  const { exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
  const rows = all.map((item) => Object.fromEntries(
    columns.map((key) => [key, pressingCell(item, key)])
  ));
  const footer = Object.fromEntries(
    columns.map((key) => [
      key,
      key === "weightKg"
        ? Number(first.summary.totalKg)
        : key === "bales"
          ? first.summary.totalBales
          : key === columns[0]
            ? "TOTAL ACTIVE"
            : "",
    ])
  );
  const stamp = (filters.from || "all-time") + "_" + (filters.to || "all-time");
  onProgress?.("Preparing Excel workbook");
  await exportOperationalWorkbook({
    title: filters.mode === "condensed" ? "Pressing Machines — Daily Summary" : "Pressing Machines — Detailed History",
    fileName: "pressing-machines-" + filters.mode + "-" + stamp + ".xlsx",
    filters: [
      { label: "Period (Beirut)", value:
        (filters.from ? filters.from + (filters.fromTime ? " " + filters.fromTime : "") : "All time") +
        " to " +
        (filters.to ? filters.to + (filters.toTime ? " " + filters.toTime : "") : "All time") },
      { label: "As of", value: pressingDisplayDateTime(first.asOf) },
      { label: "Accepted bales", value: String(first.summary.totalBales) },
      { label: "Voided bales", value: String(first.summary.voidedBales) },
      { label: "Accepted KG", value: first.summary.totalKg },
    ],
    sheets: [{
      name: filters.mode === "condensed" ? "Daily Summary" : "Detailed History",
      columns: columns.map((key) => ({
        key,
        header: PRESSING_COLUMN_LABELS[key],
        type: key === "weightKg" || key === "secondsSincePrevious"
          ? "decimal" as const
          : key === "bales" ? "integer" as const : "auto" as const,
        width: Math.min(40, Math.max(14, (PRESSING_COLUMN_LABELS[key] || "").length + 5)),
      })),
      rows,
      footer,
    }],
  });
}
