/**
 * Phase 7 ExcelJS dispatch reports. Uses the project's buffered Excel bridge
 * (never wb.xlsx.write(stream), which is unreliable in this deployment).
 *
 * All external text is plain text, prefixed if it resembles an Excel formula.
 * Weight and count columns are real numeric cells for filtering/summing.
 */
import type ExcelJS from "exceljs";
import { createWorkbook } from "../../../excelHelper";
import type { DispatchReport } from "./loadingDispatchReportData";

// True when Excel would read the text as a formula: after any leading
// control or space characters (code <= 0x20) comes = + @ or -, or the
// leading run itself contains a tab, carriage return or line feed.
function startsLikeFormula(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code === 9 || code === 10 || code === 13) return true;
    if (code > 0x20) return "=+@-".includes(text[i]);
  }
  return false;
}

function safeCell(input: unknown): string | number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === "number") return Number.isFinite(input) ? input : null;
  if (typeof input === "boolean") return input ? "Yes" : "No";
  const text = typeof input === "object" ? JSON.stringify(input) : String(input);
  // Spreadsheet formula injection defense; includes leading whitespace
  // followed by one of Excel's formula/control prefix characters.
  return startsLikeFormula(text) ? "'" + text : text;
}
function formattedDate(input: unknown): string | null {
  if (input == null || input === "") return null;
  const d = new Date(String(input));
  return Number.isNaN(d.getTime()) ? String(input) : d.toISOString().replace("T", " ").replace(".000Z", " UTC");
}
function round(value: unknown, digits = 3): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 10 ** digits) / 10 ** digits : null;
}

// safeCell renders booleans as "Yes" / "No".
type SheetCell = string | number | boolean | null;
function makeSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  headers: string[],
  rows: SheetCell[][],
  numericColumns: number[] = []
) {
  const ws = workbook.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.addRow(headers);
  for (const row of rows) ws.addRow(row.map((value) => safeCell(value)));
  ws.columns = headers.map((heading, index) => ({
    key: "col" + index,
    width: Math.min(
      55,
      Math.max(15, heading.length + 5, ...rows.slice(0, 80).map((r) => Math.min(55, String(r[index] ?? "").length + 2)))
    ),
  }));
  const header = ws.getRow(1);
  header.height = 25;
  header.font = { bold: true, color: { argb: "FFFFFFFF" } };
  header.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF18365C" } };
  header.alignment = { vertical: "middle", wrapText: true };
  for (let i = 1; i <= headers.length; i++) {
    const cell = header.getCell(i);
    cell.border = { bottom: { style: "thin", color: { argb: "FF4B75A5" } } };
  }
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, ws.rowCount), column: headers.length } };
  for (const col of numericColumns) ws.getColumn(col).numFmt = "#,##0.###;[Red](#,##0.###);0";
  for (let i = 2; i <= ws.rowCount; i++) {
    const row = ws.getRow(i);
    if (i % 2 === 0) {
      row.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF1F6FC" } };
    }
    row.alignment = { vertical: "middle" };
  }
  ws.pageSetup = {
    paperSize: 9,
    orientation: "landscape",
    fitToPage: true,
    fitToWidth: 1,
    fitToHeight: 0,
    margins: { left: 0.25, right: 0.25, top: 0.5, bottom: 0.5, header: 0.25, footer: 0.25 },
  };
  return ws;
}
function formatTrip(trip: { dispatchNumber: number; truckPlate?: string | null }) {
  return "Dispatch #" + String(trip.dispatchNumber).padStart(3, "0") + (trip.truckPlate ? " – " + trip.truckPlate : "");
}

export function buildFactoryLoadingDispatchWorkbook(report: DispatchReport): ExcelJS.Workbook {
  const wb = createWorkbook();
  wb.creator = "Factory Dispatch Verification";
  wb.subject = "Read-only physical truck verification against an existing loading";
  wb.title = report.trip ? formatTrip(report.trip) + " manifest" : "Loading dispatch reconciliation";
  wb.created = new Date();

  const comp = report.comparison;
  const summary = comp.summary;
  const meta: SheetCell[][] = [
    ["Report", report.trip ? "Truck Dispatch Manifest" : "Loading Dispatch Reconciliation"],
    ["Mode", report.source === "CLOSURE" ? "Historical closure (frozen)" : "Live verification"],
    ["Generated at (UTC)", formattedDate(report.generatedAt)],
    ["Company", report.loading.companyName],
    ["Customer", report.loading.customerName],
    ["Proforma", report.loading.proformaName],
    ["Container", report.trip?.containerNumberSnapshot ?? report.loading.containerNumber],
    ["Loading Order ID", report.loading.orderId],
    ["Loading Status", report.loading.status],
    ["Dispatch", report.trip ? formatTrip(report.trip) : "All trips"],
    ["Dispatch Status", report.trip?.status ?? "Multiple"],
    ["Truck Plate", report.trip?.truckPlate ?? null],
    ["Driver", report.trip?.driverName ?? null],
    ["Destination", report.trip?.destination ?? null],
    ["Trip Notes", report.trip?.notes ?? null],
    ["Opened by", report.trip?.createdByUsername ?? null],
    ["Opened at (UTC)", formattedDate(report.trip?.createdAt)],
    ["Closed by", report.closure?.closedByUsername ?? report.trip?.closedByUsername ?? null],
    ["Closed at (UTC)", formattedDate(report.closure?.closedAt ?? report.trip?.closedAt)],
    ["Closure Revision", report.closure?.revision ?? null],
    ["Closure Fingerprint", report.closure?.fingerprint ?? null],
    ["Discrepancy Approved", report.closure?.approvedWithDiscrepancies ?? null],
    ["Approval Reason", report.closure?.discrepancyReason ?? null],
    ["Scanned Manifest Archived", report.manifestAvailable],
    ["Loaded Bales", summary.loadedBales],
    ["Loaded KG", round(summary.loadedWeightKg)],
    ["Expected Bales", summary.expectedBales],
    ["Expected KG", round(summary.expectedWeightKg)],
    ["Verified Bales", summary.verifiedBales],
    ["Verified KG", round(summary.verifiedWeightKg)],
    ["Matched Bales", summary.matchedBales],
    ["Missing Bales", summary.missingBales],
    ["Unexpected Scans", summary.unexpectedBales],
    ["Wrong-Trip Bales", summary.crossTripMisplacedBales],
    ["Active Duplicate Anomalies", summary.duplicateBales],
    ["Weight Difference KG", round(summary.weightDifferenceKg)],
    ["Progress %", summary.progressPercent],
    ["Report Notices", report.notices.join(" | ") || null],
  ];
  makeSheet(wb, "Summary", ["Field", "Value"], meta, []);

  if (!report.trip) {
    makeSheet(
      wb,
      "Truck Trips",
      ["Dispatch", "Truck Plate", "Status", "Verified Bales", "Verified KG"],
      comp.trips.map((t) => [t.dispatchNumber, t.truckPlate, t.status, t.scannedBales, round(t.scannedWeightKg)]),
      [1, 4, 5]
    );
  }

  makeSheet(
    wb,
    "Article Comparison",
    [
      "Priority",
      "Article",
      "Product",
      "Expected Qty",
      "Verified Qty",
      "Matched Qty",
      "Missing Qty",
      "Extra Qty",
      "Expected KG",
      "Verified KG",
      "KG Difference",
      "Result",
    ],
    comp.articles.map((a) => [
      a.priorityRank,
      a.articleCode,
      a.productName,
      a.expectedQty,
      a.scannedQty,
      a.matchedQty,
      a.missingQty,
      a.extraQty,
      round(a.expectedWeightKg),
      round(a.scannedWeightKg),
      a.expectedWeightKg === null ? null : round(a.expectedWeightKg - a.scannedWeightKg),
      a.status,
    ]),
    [1, 4, 5, 6, 7, 8, 9, 10, 11]
  );

  makeSheet(
    wb,
    "Verified Bales",
    [
      "Dispatch",
      "Bale Reference",
      "Article",
      "Product",
      "Weight KG",
      "Scanned By",
      "Scan Time UTC",
      "Bale ID",
      "Scan ID",
    ],
    report.scans.map((s) => [
      s.dispatchNumber,
      s.baleReference,
      s.articleCode,
      s.productName,
      round(s.weightKg),
      s.scannedBy,
      formattedDate(s.scannedAt),
      s.baleId,
      s.scanId,
    ]),
    [1, 5, 8]
  );

  const baleHeaders = [
    "Bale Reference",
    "Article",
    "Product",
    "Weight KG",
    "Reason",
    "Scanned Dispatch",
    "Expected Dispatch",
    "Scanned By",
    "Scan Time UTC",
  ];
  const baleRow = (b: (typeof comp.missingBales)[number]): SheetCell[] => [
    b.baleReference,
    b.articleCode,
    b.productName,
    round(b.weightKg),
    b.reason,
    b.dispatchNumber ?? null,
    b.expectedDispatchNumber ?? null,
    b.scannedBy ?? null,
    formattedDate(b.scannedAt),
  ];
  makeSheet(wb, "Missing Bales", baleHeaders, comp.missingBales.map(baleRow), [4, 6, 7]);
  makeSheet(wb, "Unexpected Bales", baleHeaders, comp.unexpectedBales.map(baleRow), [4, 6, 7]);
  makeSheet(wb, "Wrong Truck", baleHeaders, comp.crossTripBales.map(baleRow), [4, 6, 7]);
  if (comp.duplicateBales.length) {
    makeSheet(wb, "Duplicate Anomalies", baleHeaders, comp.duplicateBales.map(baleRow), [4, 6, 7]);
  }
  makeSheet(
    wb,
    "Audit Trail",
    ["Event ID", "Dispatch ID", "Event", "Actor", "Time UTC", "Details"],
    report.audit.map((a) => [
      a.id,
      a.dispatchId,
      a.eventType,
      a.actorUsername,
      formattedDate(a.createdAt),
      JSON.stringify(a.details),
    ])
  );
  return wb;
}
