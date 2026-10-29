import type ExcelJS from "exceljs";
import type { ProductionTargetBonusHistoryRow, ProductionTargetBonusReport } from "@shared/productionTargetBonusReporting";
import { bonusMoneyToCents, buildProductionTargetBonusReport } from "@shared/productionTargetBonusReporting";

// Use typed text cells for source-controlled names/references; never let an
// external worker name become a spreadsheet formula.
function safeText(value: string | null | undefined): string {
  const text = String(value ?? "").replace(/[\u0000-\u001F]/g, " ").slice(0, 1000);
  return /^[=+@\-]/.test(text) ? "'" + text : text;
}
const amount = (value: string) => bonusMoneyToCents(value) / 100;
const NAVY = "FF183153";
const PALE = "FFF1F5F9";
const WHITE = "FFFFFFFF";
const DARK = "FF172337";

function makeSheet(
  book: ExcelJS.Workbook, name: string, title: string, sub: string,
  headers: string[], widths: number[], currencyColumns: number[] = [],
): ExcelJS.Worksheet {
  const sheet = book.addWorksheet(name);
  sheet.mergeCells(1, 1, 2, headers.length);
  const heading = sheet.getCell(1, 1);
  heading.value = title;
  heading.font = { name: "Aptos Display", bold: true, size: 17, color: { argb: WHITE } };
  heading.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
  heading.alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 27;
  sheet.getRow(2).height = 18;
  sheet.mergeCells(3, 1, 3, headers.length);
  sheet.getCell(3, 1).value = sub;
  sheet.getCell(3, 1).font = { name: "Aptos", color: { argb: DARK }, size: 10 };
  sheet.getRow(3).height = 25;
  const header = sheet.getRow(5);
  header.values = headers;
  header.height = 31;
  header.eachCell(cell => {
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  widths.forEach((width, index) => { sheet.getColumn(index + 1).width = width; });
  currencyColumns.forEach(index => { sheet.getColumn(index).numFmt = '#,##0.00;[Red](#,##0.00)'; });
  sheet.views = [{ state: "frozen", ySplit: 5, showGridLines: false }];
  sheet.pageSetup = { paperSize: 9, orientation: "landscape", fitToPage: true, fitToWidth: 1,
    fitToHeight: 0, margins: { left: 0.25, right: 0.25, top: 0.45,
      bottom: 0.45, header: 0.2, footer: 0.2 } };
  sheet.headerFooter.oddFooter = "Production Target Bonuses | Page &P of &N";
  return sheet;
}

function append(sheet: ExcelJS.Worksheet, values: Array<string | number | null>): void {
  const row = sheet.addRow(values.map(value => typeof value === "string" ? safeText(value) : value ?? ""));
  row.height = 24;
  row.eachCell({ includeEmpty: true }, cell => {
    cell.font = { name: "Aptos", size: 10, color: { argb: DARK } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: row.number % 2 ? PALE : WHITE } };
    cell.alignment = { vertical: "middle", wrapText: true };
    cell.border = { bottom: { style: "hair", color: { argb: "FFDCE3ED" } } };
  });
}

function finish(sheet: ExcelJS.Worksheet, columns: number, note: string): void {
  if (sheet.rowCount >= 6) {
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: sheet.rowCount, column: columns } };
  }
  const noteRow = sheet.rowCount + 2;
  sheet.mergeCells(noteRow, 1, noteRow, columns);
  const cell = sheet.getCell(noteRow, 1);
  cell.value = note;
  cell.font = { name: "Aptos", size: 10, italic: true, color: { argb: DARK } };
  cell.alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(noteRow).height = 36;
  sheet.pageSetup.printTitlesRow = "1:5";
}

function statusAmounts(row: ProductionTargetBonusHistoryRow) {
  const value = amount(row.amount);
  return {
    proposed: row.status === "PENDING" ? value : 0,
    unpaid: row.status === "APPROVED" ? value : 0,
    paid: row.status === "POSTED" ? value : 0,
  };
}

/** Pure workbook construction allows testing without browser downloads. */
export function buildProductionBonusReportWorkbook(
  report: ProductionTargetBonusReport,
  WorkbookCtor: new () => ExcelJS.Workbook,
): ExcelJS.Workbook {
  // Revalidate financial totals against source rows rather than trusting a
  // caller-supplied summary. Inconsistent/missing payment evidence is an error.
  const checked = buildProductionTargetBonusReport(report.start, report.end, report.rows, report.generatedAt);
  const book = new WorkbookCtor();
  book.creator = "Factory Production Targets";
  book.created = new Date(checked.generatedAt);
  const subtitle = "Production dates: " + checked.start + " to " + checked.end +
    " | Payment status as of export: " + checked.generatedAt.slice(0, 19).replace("T", " ") + " UTC";

  const overview = makeSheet(book, "Bonus Overview", "PRODUCTION BONUSES | OVERVIEW", subtitle,
    ["Currency", "Accepted", "Approved / Unpaid", "Paid / Posted", "Pending Proposal", "Rejected", "Draft",
      "Awards", "Approved", "Paid", "Pending"], [16, 20, 23, 20, 22, 18, 16, 12, 13, 12, 12],
    [2, 3, 4, 5, 6, 7]);
  for (const row of checked.currencies) {
    append(overview, [row.currency, amount(row.accepted), amount(row.approvedUnpaid), amount(row.paid),
      amount(row.pendingProposed), amount(row.rejected), amount(row.draft), row.totalRows,
      row.approvedCount, row.paidCount, row.pendingCount]);
  }
  finish(overview, 11, "Accepted = approved/unpaid + posted/paid only. Pending and draft are proposals, not liabilities. Currencies are never combined.");

  const workers = makeSheet(book, "Worker Bonus Totals", "PRODUCTION BONUSES | WORKERS", subtitle,
    ["Worker", "Code", "Worker ID", "Currency", "Accepted", "Approved / Unpaid", "Paid",
      "Pending Proposal", "Rejected", "Awards", "Paid Items"], [32, 18, 13, 14, 20, 23, 20, 22, 18, 13, 13],
    [5, 6, 7, 8, 9]);
  for (const w of checked.workers) {
    append(workers, [w.workerName, w.workerCode, w.workerId, w.currency,
      amount(w.accepted), amount(w.approvedUnpaid), amount(w.paid),
      amount(w.pendingProposed), amount(w.rejected), w.totalRows, w.paidCount]);
  }
  finish(workers, 11, "Worker names and money figures use immutable award snapshots; linked-team production must not be counted a second time.");

  const history = makeSheet(book, "Bonus History", "PRODUCTION BONUSES | AUDIT HISTORY", subtitle,
    ["Production Date", "Award ID", "Worker", "Code", "Currency", "Target Bales",
      "Credited Bales", "Above Target", "Rate / Extra Bale", "Amount", "Status",
      "Approved At", "Posted At", "Payment Account", "Voucher ID", "Voucher Number", "Source Snapshot"],
    [18, 13, 29, 16, 13, 16, 18, 16, 20, 18, 16, 23, 23, 29, 15, 23, 24], [10]);
  for (const row of checked.rows) {
    append(history, [row.productionDate, row.id, row.workerNameSnapshot, row.workerCodeSnapshot, row.currency,
      row.targetBales, row.creditedBales, row.excessBales, row.bonusPerExtraBale, amount(row.amount),
      row.status, row.approvedAt, row.postedAt, row.paymentAccountNameSnapshot,
      row.paymentVoucherId, row.paymentVoucherNumber, row.productionSnapshotId]);
  }
  finish(history, 17, "Rows are historical awards. POSTED requires a real voucher and payment account; rejected/voided awards are retained for audit.");

  const statements = makeSheet(book, "Worker Statements", "PRODUCTION BONUSES | WORKER STATEMENTS", subtitle,
    ["Worker", "Currency", "Date", "Award ID", "Status", "Bales Credited", "Above Target",
      "Award Amount", "Pending Proposal", "Approved / Unpaid", "Paid", "Paid On", "Payment Source", "Voucher"],
    [30, 14, 18, 13, 15, 19, 18, 20, 22, 23, 18, 22, 28, 24], [8, 9, 10, 11]);
  const sorted = [...checked.rows].sort((a, b) => a.workerNameSnapshot.localeCompare(b.workerNameSnapshot) ||
    a.workerId - b.workerId || a.currency.localeCompare(b.currency) ||
    a.productionDate.localeCompare(b.productionDate) || a.id - b.id);
  for (const row of sorted) {
    const sums = statusAmounts(row);
    append(statements, [row.workerNameSnapshot, row.currency, row.productionDate, row.id,
      row.status, row.creditedBales, row.excessBales, amount(row.amount),
      sums.proposed, sums.unpaid, sums.paid, row.postedAt, row.paymentAccountNameSnapshot,
      row.paymentVoucherNumber || (row.paymentVoucherId ? String(row.paymentVoucherId) : "")]);
  }
  finish(statements, 14, "Statements cover bonuses EARNED in the selected dates, with payment status as of export; they are not a payment-date cash movement ledger.");
  return book;
}

export async function exportProductionBonusHistoryExcel(report: ProductionTargetBonusReport): Promise<void> {
  const excelModule = await import("exceljs");
  const runtime = excelModule.default ?? excelModule;
  const book = buildProductionBonusReportWorkbook(report, runtime.Workbook);
  const buffer = await book.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = "Production_Bonuses_" + report.start + "_to_" + report.end + ".xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1500);
  }
}
