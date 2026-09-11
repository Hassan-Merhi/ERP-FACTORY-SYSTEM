/**
 * Payload and third-party cell shapes the spreadsheet editor works with, plus
 * the pure sheet-format transform that goes with them.
 *
 * These describe the /api/spreadsheets list and the parts of the Fortune Sheet
 * and xlsx-js-style cell models this editor reads and writes; none of them
 * depend on component scope, so they live beside the page rather than in it.
 */
import type { Cell as FortuneCell, CellWithRowAndCol, Sheet as FortuneSheet } from "@fortune-sheet/core";
import type { CellObject as XlsxCellObject } from "xlsx-js-style";

/** One spreadsheet entry in the /api/spreadsheets list. */
export interface SpreadsheetListItem {
  id: number;
  name: string;
  updatedAt: string;
  createdBy?: string | null;
}

/** Border record Fortune Sheet stores on a cell (not part of its public Cell type). */
export type FortuneCellBorder = Partial<Record<"l" | "r" | "t" | "b", { style?: string | number; color?: string }>>;

/** Cell shape this editor reads, including the app-written border record. */
export type EditorCell = FortuneCell & { b?: FortuneCellBorder };

/** xlsx-js-style cell, extended with this editor's formula sentinel type. */
export type XlCell = Omit<XlsxCellObject, "t"> & { t: XlsxCellObject["t"] | "f" };

export interface XlsxFontStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  sz?: number;
  color?: { rgb: string };
  name?: string;
}

export interface XlsxCellStyleParts {
  font?: XlsxFontStyle;
  fill?: { patternType: string; fgColor: { rgb: string } };
  alignment?: { horizontal?: string; vertical?: string; wrapText?: boolean };
  border?: Record<string, { style: string; color: { rgb: string } }>;
}

// Fortune Sheet's onChange delivers sheets in dense `data` format.
// When re-opening a saved sheet, convert back to sparse `celldata` so
// Fortune Sheet's initSheetData() correctly populates the grid.
export function ensureCelldata(sheet: FortuneSheet): FortuneSheet {
  if (sheet.celldata !== undefined) return sheet; // already sparse
  if (!Array.isArray(sheet.data)) return sheet;
  const celldata: CellWithRowAndCol[] = [];
  for (let r = 0; r < sheet.data.length; r++) {
    const row = sheet.data[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v !== null && v !== undefined) {
        celldata.push({ r, c, v });
      }
    }
  }
  const { data: _data, ...rest } = sheet;
  return { ...rest, celldata };
}
