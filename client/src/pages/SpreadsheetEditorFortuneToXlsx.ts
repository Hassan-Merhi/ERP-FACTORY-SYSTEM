// Extracted from ./SpreadsheetEditor.tsx to keep that module under the source-size cap.
import type { Sheet as FortuneSheet } from "@fortune-sheet/core";
import type { ColInfo, RowInfo, WorkSheet as XlsxWorkSheet } from "xlsx-js-style";
import type { EditorCell, FortuneCellBorder, XlCell, XlsxCellStyleParts } from "./spreadsheetEditorModel";

// Fortune Sheet REQUIRES celldata (sparse format) for initialization.
// Its initSheetData() reads celldata, builds an expanded matrix, then
// OVERWRITES sheet.data — so passing dense data without celldata always
// produces a blank sheet.

// ─── Border style maps (Fortune Sheet number ↔ xlsx-js-style name) ──────────
const FS_BORDER: Record<string, string> = {
  "1": "thin",
  "2": "hair",
  "3": "dotted",
  "4": "dashed",
  "5": "dashDot",
  "6": "dashDotDot",
  "7": "double",
  "8": "medium",
  "9": "mediumDashed",
  "10": "mediumDashDot",
  "11": "mediumDashDotDot",
  "12": "slantDashDot",
  "13": "thick",
};

// ─── Fortune Sheet alignment encoding ───────────────────────────────────────
// Horizontal: toolbar reveals value: 1=left, 0=center, 2=right
const FS_HT: Record<string, string> = { "0": "center", "1": "left", "2": "right" };

// Vertical:   toolbar reveals value: 1=top, 0=middle, 2=bottom
const FS_VT: Record<string, string> = { "0": "center", "1": "top", "2": "bottom" };

export function fortuneToXlsx(sheets: FortuneSheet[], XLSX: typeof import("xlsx-js-style")) {
  const wb = XLSX.utils.book_new();

  for (const sheet of sheets) {
    const ws: XlsxWorkSheet = {};
    let maxR = 0;
    let maxC = 0;

    const writeCell = (r: number, c: number, v: EditorCell | null) => {
      if (!v) return;
      const hasValue = v.v !== undefined || v.m !== undefined || v.f;
      if (!hasValue) return;

      const addr = XLSX.utils.encode_cell({ r, c });
      const val = v.v ?? v.m;
      const xlCell: XlCell = {
        v: val,
        t: v.f ? "f" : typeof val === "number" ? "n" : typeof val === "boolean" ? "b" : "s",
        w: v.m !== undefined ? String(v.m) : val !== undefined ? String(val) : "",
      };

      // Formula: stored without "=" in both SheetJS and Fortune Sheet
      if (v.f) xlCell.f = v.f;

      // Number format
      const fa = v.ct?.fa;
      if (fa && fa !== "General" && fa !== "@") xlCell.z = fa;

      // Style object
      const s: XlsxCellStyleParts = {};

      // Font
      if (v.bl || v.it || v.un || v.cl || v.fs || v.fc || v.ff) {
        s.font = {};
        if (v.bl) s.font.bold = true;
        if (v.it) s.font.italic = true;
        if (v.un) s.font.underline = true;
        if (v.cl) s.font.strike = true;
        if (v.fs) s.font.sz = Number(v.fs);
        if (v.fc) s.font.color = { rgb: v.fc.replace("#", "").toUpperCase() };
        if (v.ff) s.font.name = String(v.ff);
      }

      // Fill / background
      if (v.bg) {
        s.fill = { patternType: "solid", fgColor: { rgb: v.bg.replace("#", "").toUpperCase() } };
      }

      // Alignment
      const ht = FS_HT[String(v.ht)];
      const vt = FS_VT[String(v.vt)];
      const wrap = String(v.tb) === "2";
      if (ht || vt || wrap) {
        s.alignment = {};
        if (ht) s.alignment.horizontal = ht;
        if (vt) s.alignment.vertical = vt;
        if (wrap) s.alignment.wrapText = true;
      }

      // Borders
      if (v.b) {
        const sides: Record<string, string> = { l: "left", r: "right", t: "top", b: "bottom" };
        const border: Record<string, { style: string; color: { rgb: string } }> = {};
        for (const [fs, xl] of Object.entries(sides)) {
          const bd = v.b[fs as keyof FortuneCellBorder];
          if (bd?.style) {
            border[xl] = {
              style: FS_BORDER[String(bd.style)] || "thin",
              color: { rgb: (bd.color || "#000000").replace("#", "").toUpperCase() },
            };
          }
        }
        if (Object.keys(border).length > 0) s.border = border;
      }

      if (Object.keys(s).length > 0) xlCell.s = s;

      ws[addr] = xlCell;
      maxR = Math.max(maxR, r);
      maxC = Math.max(maxC, c);
    };

    const sheetData = sheet.data;
    if (sheetData && Array.isArray(sheetData) && sheetData.length > 0) {
      for (let r = 0; r < sheetData.length; r++) {
        if (!sheetData[r]) continue;
        for (let c = 0; c < sheetData[r].length; c++) writeCell(r, c, sheetData[r][c]);
      }
    } else {
      for (const cell of sheet.celldata || []) writeCell(cell.r, cell.c, cell.v);
    }

    ws["!ref"] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: maxR, c: maxC } });

    const cfg = sheet.config || {};

    // Merged cells
    if (cfg.merge) {
      ws["!merges"] = Object.values(cfg.merge).map((m) => ({
        s: { r: m.r, c: m.c },
        e: { r: m.r + m.rs - 1, c: m.c + m.cs - 1 },
      }));
    }

    // Column widths + hidden
    if (cfg.columnlen || cfg.colhidden) {
      const cMax = Math.max(
        ...Object.keys(cfg.columnlen || {}).map(Number),
        ...Object.keys(cfg.colhidden || {}).map(Number),
        maxC
      );
      const xlCols: ColInfo[] = Array.from({ length: cMax + 1 }, () => ({}));
      for (const [ci, w] of Object.entries(cfg.columnlen || {})) {
        xlCols[Number(ci)].wpx = w;
        xlCols[Number(ci)].wch = Math.round((w / 7) * 100) / 100;
      }
      for (const ci of Object.keys(cfg.colhidden || {})) xlCols[Number(ci)].hidden = true;
      ws["!cols"] = xlCols;
    }

    // Row heights + hidden
    if (cfg.rowlen || cfg.rowhidden) {
      const rMax = Math.max(
        ...Object.keys(cfg.rowlen || {}).map(Number),
        ...Object.keys(cfg.rowhidden || {}).map(Number),
        maxR
      );
      const xlRows: RowInfo[] = Array.from({ length: rMax + 1 }, () => ({}));
      for (const [ri, h] of Object.entries(cfg.rowlen || {})) {
        xlRows[Number(ri)].hpx = h;
        xlRows[Number(ri)].hpt = Math.round((h / 1.333) * 100) / 100;
      }
      for (const ri of Object.keys(cfg.rowhidden || {})) xlRows[Number(ri)].hidden = true;
      ws["!rows"] = xlRows;
    }

    // Auto filter
    const fs = sheet.filter_select;
    if (fs) {
      const c1 = XLSX.utils.encode_col(fs.column[0]);
      const c2 = XLSX.utils.encode_col(fs.column[1]);
      ws["!autofilter"] = { ref: `${c1}${fs.row[0] + 1}:${c2}${fs.row[1] + 1}` };
    }

    XLSX.utils.book_append_sheet(wb, ws, sheet.name || "Sheet");
  }
  return wb;
}

export function defaultBlankSheets(): FortuneSheet[] {
  return [
    {
      id: "1",
      name: "Sheet1",
      status: 1,
      order: 0,
      celldata: [],
      row: 50,
      column: 26,
    } as FortuneSheet,
  ];
}

/** Convert 0-based column index to Excel letter(s): 0→A, 25→Z, 26→AA … */
export function indexToColLetter(n: number): string {
  let result = "";
  let i = n;
  do {
    result = String.fromCharCode(65 + (i % 26)) + result;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return result;
}
