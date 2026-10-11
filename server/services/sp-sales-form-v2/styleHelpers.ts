import ExcelJS from "exceljs";
import { normSm, right, thin, NUM } from "./constants";
import { parseMoneyInput } from "../../lib/money";

// ── Pure numeric helpers ──────────────────────────────────────────────────────
export const pn = (v: unknown): number => parseMoneyInput(String(v ?? "0"))?.toNumber() ?? 0;
export const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
export const r4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

// ── Cell helpers ──────────────────────────────────────────────────────────────
export function applyCell(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: unknown,
  f?: ExcelJS.Fill,
  font?: Partial<ExcelJS.Font>,
  align?: Partial<ExcelJS.Alignment>
): void {
  const c = ws.getCell(row, col);
  c.value = value as ExcelJS.CellValue;
  if (f) c.fill = f;
  if (font) c.font = font;
  if (align) c.alignment = align;
  c.border = thin;
}

export function setCellVal(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: unknown,
  font?: Partial<ExcelJS.Font>,
  f?: ExcelJS.Fill,
  align?: Partial<ExcelJS.Alignment>
): void {
  const c = ws.getCell(row, col);
  c.value = value as ExcelJS.CellValue;
  if (font) c.font = font;
  if (f) c.fill = f;
  if (align) c.alignment = align;
  c.border = thin;
}

export function setCellNum(
  ws: ExcelJS.Worksheet,
  row: number,
  col: number,
  value: number | null,
  f?: ExcelJS.Fill,
  numFmt = NUM
): void {
  const c = ws.getCell(row, col);
  c.value = value;
  c.numFmt = numFmt;
  c.font = normSm;
  c.alignment = right;
  c.border = thin;
  if (f) c.fill = f;
}
