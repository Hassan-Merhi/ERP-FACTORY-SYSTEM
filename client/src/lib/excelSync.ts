import type ExcelJS from "exceljs";
import type { Cell as FortuneCell, Sheet as FortuneSheet } from "@fortune-sheet/core";
import { asRecord } from "@shared/typeGuards";

// ─── Types ────────────────────────────────────────────────────────────────────

/** One side of a Fortune Sheet cell border, as the editor serializes it. */
interface FortuneCellBorder {
  style?: number | string;
  color?: string;
}

/**
 * A Fortune Sheet cell as this converter consumes it.
 *
 * `@fortune-sheet/core`'s exported `Cell` is incomplete for round-tripping: it
 * has no per-side border record (`b`), which the editor does write, and it
 * types the text-wrap flag `tb` as a string although saved sheets carry it as a
 * number. Extending the library type here names exactly what the declaration is
 * missing while leaving every other field checked against the library.
 */
type SyncedFortuneCell = Omit<FortuneCell, "tb"> & {
  b?: Partial<Record<FortuneBorderSide, FortuneCellBorder>>;
  tb?: string | number;
};

type FortuneBorderSide = "l" | "r" | "t" | "b";

export type ExcelSpreadsheetData = {
  mode: "excel";
  rawXlsx: string; // base64-encoded original .xlsx binary
  sheets: FortuneSheet[];
};

export type SpreadsheetData = ExcelSpreadsheetData | FortuneSheet[];

/**
 * A saved spreadsheet is opaque JSON from a `jsonb` column, so it arrives as
 * `unknown` and this guard is what makes it usable — the narrowing is the point
 * of the function, and it must not start from a type it never verified.
 */
export function isExcelMode(data: unknown): data is ExcelSpreadsheetData {
  const record = asRecord(data);
  return record?.mode === "excel" && typeof record.rawXlsx === "string";
}

// ─── Base64 helpers ──────────────────────────────────────────────────────────

export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  // Process byte-by-byte to stay compatible with all TS/ES targets
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

// ─── Style maps ───────────────────────────────────────────────────────────────

// Fortune Sheet border style number → ExcelJS style string
const FS_TO_XL_BORDER: Record<number, string> = {
  1: "thin",
  2: "hair",
  3: "dotted",
  4: "dashed",
  5: "dashDot",
  6: "dashDotDot",
  7: "double",
  8: "medium",
  9: "mediumDashed",
  10: "mediumDashDot",
  11: "mediumDashDotDot",
  12: "slantDashDot",
  13: "thick",
};

// Fortune Sheet ht → ExcelJS horizontal alignment
const FS_TO_XL_H: Record<number, ExcelJS.Alignment["horizontal"]> = {
  0: "center",
  1: "left",
  2: "right",
};

// Fortune Sheet vt → ExcelJS vertical alignment
const FS_TO_XL_V: Record<number, ExcelJS.Alignment["vertical"]> = {
  0: "middle",
  1: "top",
  2: "bottom",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Converts #RRGGBB to ExcelJS ARGB (FFRRGGBB) */
function hexToArgb(hex?: string): string {
  if (!hex) return "FF000000";
  return "FF" + hex.replace("#", "").toUpperCase().padStart(6, "0");
}

/** Iterates Fortune Sheet cells regardless of sparse (celldata) or dense (data) format */
function iterateFortuneCells(sheet: FortuneSheet, cb: (r: number, c: number, v: SyncedFortuneCell) => void): void {
  const s = sheet;
  if (Array.isArray(s.celldata)) {
    for (const { r, c, v } of s.celldata) {
      if (v !== null && v !== undefined) cb(r, c, v);
    }
  } else if (Array.isArray(s.data)) {
    for (let r = 0; r < s.data.length; r++) {
      const row = s.data[r];
      if (!Array.isArray(row)) continue;
      for (let c = 0; c < row.length; c++) {
        const v = row[c];
        if (v !== null && v !== undefined) cb(r, c, v);
      }
    }
  }
}

/** Maps Fortune Sheet cell value object into an ExcelJS cell */
function applyFortuneStyleToCell(excelCell: ExcelJS.Cell, v: SyncedFortuneCell | null): void {
  if (!v) {
    excelCell.value = null;
    return;
  }

  // Value / formula
  if (v.f) {
    excelCell.value = { formula: v.f, result: v.v ?? undefined } as ExcelJS.CellValue;
  } else if (v.v !== undefined && v.v !== null) {
    excelCell.value = v.v;
  } else if (v.m !== undefined && v.m !== "") {
    excelCell.value = v.m;
  } else {
    excelCell.value = null;
  }

  // Font
  if (v.bl || v.it || v.un || v.cl || v.fs || v.fc || v.ff) {
    const font: Partial<ExcelJS.Font> = {};
    if (v.bl) font.bold = true;
    if (v.it) font.italic = true;
    if (v.un) font.underline = true;
    if (v.cl) font.strike = true;
    if (v.fs) font.size = Number(v.fs);
    if (v.fc) font.color = { argb: hexToArgb(v.fc) };
    if (v.ff) font.name = String(v.ff);
    excelCell.font = font as ExcelJS.Font;
  }

  // Fill
  if (v.bg) {
    excelCell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: hexToArgb(v.bg) },
    } as ExcelJS.Fill;
  }

  // Alignment
  const ht = v.ht !== undefined ? FS_TO_XL_H[Number(v.ht)] : undefined;
  const vt = v.vt !== undefined ? FS_TO_XL_V[Number(v.vt)] : undefined;
  const wrap = v.tb === 2 || v.tb === "2";
  if (ht || vt || wrap) {
    const alignment: Partial<ExcelJS.Alignment> = {};
    if (ht) alignment.horizontal = ht;
    if (vt) alignment.vertical = vt;
    if (wrap) alignment.wrapText = true;
    excelCell.alignment = alignment as ExcelJS.Alignment;
  }

  // Borders
  if (v.b) {
    const border: Partial<ExcelJS.Borders> = {};
    const sides: [FortuneBorderSide, keyof ExcelJS.Borders][] = [
      ["l", "left"],
      ["r", "right"],
      ["t", "top"],
      ["b", "bottom"],
    ];
    for (const [fsKey, xlKey] of sides) {
      const bd = v.b[fsKey];
      if (bd?.style) {
        const style = FS_TO_XL_BORDER[Number(bd.style)];
        if (style) {
          (border as { [key: string]: unknown })[xlKey] = {
            style,
            color: { argb: hexToArgb(bd.color) },
          };
        }
      }
    }
    if (Object.keys(border).length > 0) excelCell.border = border as ExcelJS.Borders;
  }

  // Number format
  const fa = v.ct?.fa;
  if (fa && fa !== "General" && fa !== "@") {
    excelCell.numFmt = fa;
  }
}

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Applies Fortune Sheet edits back into the original xlsx workbook.
 * Advanced features (tables, conditional formatting, data validation,
 * named ranges) are preserved automatically because ExcelJS reads and
 * re-writes them without modification.
 */
export async function syncFortuneToXlsx(rawXlsx: string, sheets: FortuneSheet[]): Promise<ArrayBuffer> {
  const excelJsModule = await import("exceljs");
  const ExcelJSRuntime = excelJsModule.default ?? excelJsModule;
  const wb = new ExcelJSRuntime.Workbook();
  await wb.xlsx.load(base64ToArrayBuffer(rawXlsx));

  for (let sheetIdx = 0; sheetIdx < sheets.length; sheetIdx++) {
    const fsSheet = sheets[sheetIdx];

    // Match by name first, fall back to index
    let ws = wb.getWorksheet(fsSheet.name);
    if (!ws) ws = wb.getWorksheet(sheetIdx + 1);
    if (!ws) continue;

    // Build a map of Fortune Sheet cells: "r_c" → cell value object
    const cellMap = new Map();
    let maxFsR = 0;
    let maxFsC = 0;

    iterateFortuneCells(fsSheet, (r, c, v) => {
      cellMap.set(`${r}_${c}`, v);
      if (r > maxFsR) maxFsR = r;
      if (c > maxFsC) maxFsC = c;
    });

    // Determine bounding range from ExcelJS dimensions
    let maxExcelR = 0;
    let maxExcelC = 0;
    try {
      // ExcelJS types `dimensions` as a Range, whose bottom/right are the
      // 1-based last used row and column.
      const dim = ws.dimensions;
      if (dim) {
        maxExcelR = Math.max(0, (dim.bottom ?? 0) - 1);
        maxExcelC = Math.max(0, (dim.right ?? 0) - 1);
      }
    } catch {
      // ignore
    }

    const boundR = Math.max(maxFsR, maxExcelR);
    const boundC = Math.max(maxFsC, maxExcelC);

    // Apply cell values and styles over the full bounding range
    for (let r = 0; r <= boundR; r++) {
      for (let c = 0; c <= boundC; c++) {
        const key = `${r}_${c}`;
        const excelCell = ws.getCell(r + 1, c + 1);
        const v = cellMap.get(key);
        if (v !== undefined) {
          applyFortuneStyleToCell(excelCell, v);
        } else {
          // Cell was cleared in Fortune Sheet — clear the Excel cell value
          // but do NOT clear style (preserves table header styling, etc.)
          excelCell.value = null;
        }
      }
    }

    // ── Merged cells: unmerge all, then re-apply Fortune Sheet merges ─────
    // Collect existing merge addresses before modifying
    const existingMergeAddrs = Object.keys((ws as unknown as ExcelJS.Worksheet & { _merges: {} })._merges || {});
    for (const addr of existingMergeAddrs) {
      try {
        ws.unMergeCells(addr);
      } catch {
        // ignore invalid merge
      }
    }
    const cfg = fsSheet.config || {};
    if (cfg.merge) {
      for (const m of Object.values(cfg.merge)) {
        try {
          ws.mergeCells(m.r + 1, m.c + 1, m.r + m.rs, m.c + m.cs);
        } catch {
          // ignore merge errors
        }
      }
    }

    // ── Row heights / hidden ──────────────────────────────────────────────
    if (cfg.rowlen) {
      for (const [ri, hpx] of Object.entries(cfg.rowlen)) {
        const row = ws.getRow(Number(ri) + 1);
        row.height = Math.round(Number(hpx) / 1.333);
      }
    }
    if (cfg.rowhidden) {
      for (const ri of Object.keys(cfg.rowhidden)) {
        ws.getRow(Number(ri) + 1).hidden = true;
      }
    }

    // ── Column widths / hidden ────────────────────────────────────────────
    if (cfg.columnlen) {
      for (const [ci, wpx] of Object.entries(cfg.columnlen)) {
        const col = ws.getColumn(Number(ci) + 1);
        col.width = Math.round((Number(wpx) / 7) * 100) / 100;
      }
    }
    if (cfg.colhidden) {
      for (const ci of Object.keys(cfg.colhidden)) {
        ws.getColumn(Number(ci) + 1).hidden = true;
      }
    }

    // ── Advanced features are NOT touched ────────────────────────────────
    // ExcelJS preserves tables, conditionalFormattings, dataValidations,
    // autoFilter, and wb.definedNames automatically from the loaded binary.
  }

  return (await wb.xlsx.writeBuffer()) as ArrayBuffer;
}
