// Extracted from ./productionBonusHistoryExcel.ts
import type ExcelJS from "exceljs";

// Use typed text cells for source-controlled names/references; never let an
// external worker name become a spreadsheet formula.
// C0 control characters become spaces (code-point check, no control-char regex).
function blankControlCharacters(text: string): string {
  return Array.from(text, (char) => ((char.codePointAt(0) ?? 0) < 0x20 ? " " : char)).join("");
}

export function safeText(value: string | null | undefined): string {
  const text = blankControlCharacters(String(value ?? "")).slice(0, 1000);
  return /^[=+@-]/.test(text) ? "'" + text : text;
}

const NAVY = "FF183153";

export const PALE = "FFF1F5F9";

export const WHITE = "FFFFFFFF";

export const DARK = "FF172337";

export function makeSheet(
  book: ExcelJS.Workbook,
  name: string,
  title: string,
  sub: string,
  headers: string[],
  widths: number[],
  currencyColumns: number[] = []
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
  header.eachCell((cell) => {
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: WHITE } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: NAVY } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  widths.forEach((width, index) => {
    sheet.getColumn(index + 1).width = width;
  });
  currencyColumns.forEach((index) => {
    sheet.getColumn(index).numFmt = "#,##0.00;[Red](#,##0.00)";
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
  sheet.headerFooter.oddFooter = "Production Target Bonuses | Page &P of &N";
  return sheet;
}
