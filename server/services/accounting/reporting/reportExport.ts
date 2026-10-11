/**
 * Excel and PDF exports of the financial statements (accounting audit
 * phase 27, RP-1).
 *
 * Every export is rendered from the same service result the page shows
 * (trial balance, balance sheet, P&L, aging, ratios, cash flow), mapped to one
 * tabular shape (`ReportTable`) and written by one Excel writer (exceljs) and
 * one PDF writer (pdfkit). Amounts stay the services' exact 2-decimal strings:
 * Excel cells get them as numbers with a 2-decimal format only at the cell,
 * the PDF prints the strings.
 */
import PDFDocument from "pdfkit";

export interface ReportColumn {
  key: string;
  label: string;
  numeric?: boolean;
}

export interface ReportTableRow {
  cells: Record<string, string | null>;
  /** Section headings and totals are printed in bold. */
  emphasis?: "heading" | "total";
}

export interface ReportTable {
  title: string;
  subtitle: string;
  columns: ReportColumn[];
  rows: ReportTableRow[];
  notes?: string[];
}

export type ReportExportFormat = "xlsx" | "pdf";
export const REPORT_EXPORT_FORMATS: readonly ReportExportFormat[] = ["xlsx", "pdf"];

export interface RenderedExport {
  buffer: Buffer;
  contentType: string;
  extension: ReportExportFormat;
}

/** A safe file name stem: letters, digits, dashes and underscores only. */
export function exportFileStem(title: string, date: string): string {
  const stem = `${title}_${date}`.replace(/[^A-Za-z0-9_-]+/g, "_").replace(/_+/g, "_");
  return stem.replace(/^_|_$/g, "") || "report";
}

async function renderXlsx(table: ReportTable): Promise<Buffer> {
  const ExcelJS = (await import("exceljs")).default;
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(table.title.slice(0, 31) || "Report");
  sheet.addRow([table.title]).font = { bold: true, size: 14 };
  sheet.addRow([table.subtitle]);
  sheet.addRow([]);
  const header = sheet.addRow(table.columns.map((column) => column.label));
  header.font = { bold: true };
  for (const row of table.rows) {
    const values = table.columns.map((column) => {
      const value = row.cells[column.key];
      if (value === null || value === undefined || value === "") return null;
      // The exact string becomes a numeric cell; the cell format shows 2 decimals.
      return column.numeric ? Number(value) : value;
    });
    const added = sheet.addRow(values);
    if (row.emphasis) added.font = { bold: true };
  }
  table.columns.forEach((column, index) => {
    const excelColumn = sheet.getColumn(index + 1);
    excelColumn.width = column.numeric ? 16 : 36;
    if (column.numeric) excelColumn.numFmt = "#,##0.00;[Red]-#,##0.00";
  });
  if (table.notes?.length) {
    sheet.addRow([]);
    for (const note of table.notes) sheet.addRow([note]);
  }
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data as ArrayBuffer);
}

function renderPdf(table: ReportTable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const landscape = table.columns.length > 5;
    const doc = new PDFDocument({ margin: 32, size: "A4", layout: landscape ? "landscape" : "portrait" });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const numericCount = table.columns.filter((column) => column.numeric).length;
    const textCount = table.columns.length - numericCount;
    const numericWidth = Math.min(90, (width * 0.6) / Math.max(numericCount, 1));
    const textWidth = (width - numericWidth * numericCount) / Math.max(textCount, 1);
    const widths = table.columns.map((column) => (column.numeric ? numericWidth : textWidth));

    doc.font("Helvetica-Bold").fontSize(14).text(table.title, left, doc.y);
    doc.font("Helvetica").fontSize(9).text(table.subtitle);
    doc.moveDown(0.5);

    const drawRow = (cells: string[], bold: boolean) => {
      const y = doc.y;
      if (y > doc.page.height - doc.page.margins.bottom - 20) doc.addPage();
      const rowY = doc.y;
      let x = left;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(8);
      let height = 0;
      cells.forEach((cell, index) => {
        const column = table.columns[index];
        const options = { width: widths[index] - 4, align: column?.numeric ? ("right" as const) : ("left" as const) };
        doc.text(cell, x, rowY, options);
        height = Math.max(height, doc.heightOfString(cell || " ", options));
        x += widths[index];
      });
      doc.y = rowY + height + 3;
      doc.x = left;
    };

    drawRow(
      table.columns.map((column) => column.label),
      true
    );
    doc
      .moveTo(left, doc.y)
      .lineTo(left + width, doc.y)
      .stroke();
    doc.y += 2;
    for (const row of table.rows) {
      drawRow(
        table.columns.map((column) => row.cells[column.key] ?? ""),
        Boolean(row.emphasis)
      );
    }
    if (table.notes?.length) {
      doc.moveDown();
      doc.font("Helvetica").fontSize(8);
      for (const note of table.notes) doc.text(note, left, doc.y, { width });
    }
    doc.end();
  });
}

export async function renderReportTable(table: ReportTable, format: ReportExportFormat): Promise<RenderedExport> {
  if (format === "xlsx") {
    return {
      buffer: await renderXlsx(table),
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      extension: "xlsx",
    };
  }
  return { buffer: await renderPdf(table), contentType: "application/pdf", extension: "pdf" };
}
