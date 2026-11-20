// Extracted from ./export.ts
import { styleUniversalFinancialWorkbook } from "@shared/universal-excel/financialWorkbookStyle";
import type { Response } from "express";
import ExcelJS from "exceljs";

export const NAVY = "1A2C5B";

export const GOLD = "C9A84C";

export const LIGHT_GOLD = "F7EFD8";

export const WHITE = "FFFFFF";

export const GREEN = "1A7A3E";

export const RED = "C0392B";

export const YELLOW = "856404";

export const LIGHT_RED = "FDECEA";

export const LIGHT_GREEN = "E9F7EF";

export const LIGHT_YELLOW = "FFF9E6";

export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function applyHeader(cell: ExcelJS.Cell) {
  cell.font = { bold: true, color: { argb: WHITE } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: GOLD } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
}

export function sendWorkbook(res: Response, workbook: ExcelJS.Workbook, filename: string) {
  styleUniversalFinancialWorkbook(
    workbook,
    workbook.worksheets.map((ws) => ({ name: ws.name }))
  );
  return workbook.xlsx.writeBuffer().then((raw) => {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.send(Buffer.from(raw));
  });
}
