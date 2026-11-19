// Extracted from ./generateMonthEnds.ts
import ExcelJS from "exceljs";

export function lastDayOfMonth(year: number, month: number): string {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return d.toISOString().split("T")[0];
}

export function addOneDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().split("T")[0];
}

export const C = {
  DARK_BLUE: "FF1E3A5F",
  MID_BLUE: "FF2D5F8A",
  GREEN: "FF16A34A",
  RED: "FFDC2626",
  GREEN_BG: "FFD1FAE5",
  RED_BG: "FFFEE2E2",
  YELLOW_BG: "FFFEF9C3",
  AMBER_BG: "FFFEF3C7",
  GRAY_BG: "FFF3F4F6",
  GRAY_HD: "FFE5E7EB",
  WHITE: "FFFFFFFF",
  LIGHT_BLUE: "FFE0EAF5",
  MUTED: "FF6B7280",
};

export const currencyFmt = "#,##0.00";

export const signedFmt = '+#,##0.00;-#,##0.00;"-"';

export function styleHeader(cell: ExcelJS.Cell, bgArgb = C.DARK_BLUE) {
  cell.font = { bold: true, color: { argb: C.WHITE }, size: 11 };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgArgb } };
  cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
  cell.border = { bottom: { style: "thin", color: { argb: "FFAAAAAA" } } };
}

export function setThin(cell: ExcelJS.Cell) {
  cell.border = { bottom: { style: "hair", color: { argb: "FFDDDDDD" } } };
}
