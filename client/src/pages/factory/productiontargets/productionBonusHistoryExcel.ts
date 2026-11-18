import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import type ExcelJS from "exceljs";
import type {
  ProductionTargetBonusHistoryRow,
  ProductionTargetBonusReport,
} from "@shared/productionTargetBonusReporting";
import { bonusMoneyToCents, buildProductionTargetBonusReport } from "@shared/productionTargetBonusReporting";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { safeText, PALE, WHITE, DARK, makeSheet } from "./productionBonusHistoryExcelHelpers";

const amount = (value: string) => bonusMoneyToCents(value) / 100;

function append(sheet: ExcelJS.Worksheet, values: Array<string | number | null>): void {
  const row = sheet.addRow(values.map((value) => (typeof value === "string" ? safeText(value) : (value ?? ""))));
  row.height = 24;
  row.eachCell({ includeEmpty: true }, (cell) => {
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
  WorkbookCtor: new () => ExcelJS.Workbook
): ExcelJS.Workbook {
  // Revalidate financial totals against source rows rather than trusting a
  // caller-supplied summary. Inconsistent/missing payment evidence is an error.
  const checked = buildProductionTargetBonusReport(report.start, report.end, report.rows, report.generatedAt);
  const book = new WorkbookCtor();
  book.creator = "Factory Production Targets";
  book.created = new Date(checked.generatedAt);
  const subtitle =
    "Production dates: " +
    checked.start +
    " to " +
    checked.end +
    " | Payment status as of export: " +
    checked.generatedAt.slice(0, 19).replace("T", " ") +
    " UTC";

  const overview = makeSheet(
    book,
    "Bonus Overview",
    "PRODUCTION BONUSES | OVERVIEW",
    subtitle,
    [
      "Currency",
      "Accepted",
      "Approved / Unpaid",
      "Paid / Posted",
      "Pending Proposal",
      "Rejected",
      "Draft",
      "Awards",
      "Approved",
      "Paid",
      "Pending",
    ],
    [16, 20, 23, 20, 22, 18, 16, 12, 13, 12, 12],
    [2, 3, 4, 5, 6, 7]
  );
  for (const row of checked.currencies) {
    append(overview, [
      row.currency,
      amount(row.accepted),
      amount(row.approvedUnpaid),
      amount(row.paid),
      amount(row.pendingProposed),
      amount(row.rejected),
      amount(row.draft),
      row.totalRows,
      row.approvedCount,
      row.paidCount,
      row.pendingCount,
    ]);
  }
  finish(
    overview,
    11,
    "Accepted = approved/unpaid + posted/paid only. Pending and draft are proposals, not liabilities. Currencies are never combined."
  );

  const workers = makeSheet(
    book,
    "Worker Bonus Totals",
    "PRODUCTION BONUSES | WORKERS",
    subtitle,
    [
      "Worker",
      "Code",
      "Worker ID",
      "Currency",
      "Accepted",
      "Approved / Unpaid",
      "Paid",
      "Pending Proposal",
      "Rejected",
      "Awards",
      "Paid Items",
    ],
    [32, 18, 13, 14, 20, 23, 20, 22, 18, 13, 13],
    [5, 6, 7, 8, 9]
  );
  for (const w of checked.workers) {
    append(workers, [
      w.workerName,
      w.workerCode,
      w.workerId,
      w.currency,
      amount(w.accepted),
      amount(w.approvedUnpaid),
      amount(w.paid),
      amount(w.pendingProposed),
      amount(w.rejected),
      w.totalRows,
      w.paidCount,
    ]);
  }
  finish(
    workers,
    11,
    "Worker names and money figures use immutable award snapshots; linked-team production must not be counted a second time."
  );

  const history = makeSheet(
    book,
    "Bonus History",
    "PRODUCTION BONUSES | AUDIT HISTORY",
    subtitle,
    [
      "Production Date",
      "Award ID",
      "Worker",
      "Code",
      "Currency",
      "Target Bales",
      "Credited Bales",
      "Above Target",
      "Rate / Extra Bale",
      "Amount",
      "Status",
      "Approved At",
      "Posted At",
      "Payment Account",
      "Voucher ID",
      "Voucher Number",
      "Source Snapshot",
    ],
    [18, 13, 29, 16, 13, 16, 18, 16, 20, 18, 16, 23, 23, 29, 15, 23, 24],
    [10]
  );
  for (const row of checked.rows) {
    append(history, [
      row.productionDate,
      row.id,
      row.workerNameSnapshot,
      row.workerCodeSnapshot,
      row.currency,
      row.targetBales,
      row.creditedBales,
      row.excessBales,
      row.bonusPerExtraBale,
      amount(row.amount),
      row.status,
      row.approvedAt,
      row.postedAt,
      row.paymentAccountNameSnapshot,
      row.paymentVoucherId,
      row.paymentVoucherNumber,
      row.productionSnapshotId,
    ]);
  }
  finish(
    history,
    17,
    "Rows are historical awards. POSTED requires a real voucher and payment account; rejected/voided awards are retained for audit."
  );

  const statements = makeSheet(
    book,
    "Worker Statements",
    "PRODUCTION BONUSES | WORKER STATEMENTS",
    subtitle,
    [
      "Worker",
      "Currency",
      "Date",
      "Award ID",
      "Status",
      "Bales Credited",
      "Above Target",
      "Award Amount",
      "Pending Proposal",
      "Approved / Unpaid",
      "Paid",
      "Paid On",
      "Payment Source",
      "Voucher",
    ],
    [30, 14, 18, 13, 15, 19, 18, 20, 22, 23, 18, 22, 28, 24],
    [8, 9, 10, 11]
  );
  const sorted = [...checked.rows].sort(
    (a, b) =>
      a.workerNameSnapshot.localeCompare(b.workerNameSnapshot) ||
      a.workerId - b.workerId ||
      a.currency.localeCompare(b.currency) ||
      a.productionDate.localeCompare(b.productionDate) ||
      a.id - b.id
  );
  for (const row of sorted) {
    const sums = statusAmounts(row);
    append(statements, [
      row.workerNameSnapshot,
      row.currency,
      row.productionDate,
      row.id,
      row.status,
      row.creditedBales,
      row.excessBales,
      amount(row.amount),
      sums.proposed,
      sums.unpaid,
      sums.paid,
      row.postedAt,
      row.paymentAccountNameSnapshot,
      row.paymentVoucherNumber || (row.paymentVoucherId ? String(row.paymentVoucherId) : ""),
    ]);
  }
  finish(
    statements,
    14,
    "Statements cover bonuses EARNED in the selected dates, with payment status as of export; they are not a payment-date cash movement ledger."
  );
  styleFactoryOperationalWorkbook(
    book,
    book.worksheets.map((worksheet) => ({
      name: worksheet.name,
      titleRow: 1,
      headerRow: 5,
    }))
  );
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
  downloadBlob(blob, exportFileName("production bonuses", "xlsx", { from: report.start, to: report.end }));
}
