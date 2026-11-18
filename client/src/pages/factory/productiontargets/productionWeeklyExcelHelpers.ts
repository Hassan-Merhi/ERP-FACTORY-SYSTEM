// Extracted from ./productionWeeklyExcel.ts
import type ExcelJS from "exceljs";
import { INK, WHITE } from "./buildWeeklyProductionData";

const PALE = "FFF1F5F9";

export const GREEN = "FF047857";

const RED = "FFB91C1C";

export function appendBody(
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

export function enableFilter(sheet: ExcelJS.Worksheet, lastCol: number, lastDataRow: number) {
  if (lastDataRow >= 6) {
    sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: lastDataRow, column: lastCol } };
  }
  sheet.pageSetup.printTitlesRow = "1:5";
}

export function addNote(sheet: ExcelJS.Worksheet, note: string, lastCol: number) {
  const rowIndex = sheet.rowCount + 2;
  sheet.mergeCells(rowIndex, 1, rowIndex, lastCol);
  const cell = sheet.getCell(rowIndex, 1);
  cell.value = note;
  cell.font = { name: "Aptos", size: 10, italic: true, color: { argb: INK } };
  cell.alignment = { vertical: "middle", wrapText: true };
  sheet.getRow(rowIndex).height = 46;
}
