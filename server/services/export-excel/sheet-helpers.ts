import ExcelJS from "exceljs";

export const HDR_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1E3A5F" } };
export const HDR_FONT: Partial<ExcelJS.Font> = { bold: true, color: { argb: "FFFFFFFF" }, size: 10 };
export const ALT_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF0F4FA" } };
const MAX_ROWS = 30000;

// Convert snake_case db column name to a readable Title Case header
function toHeader(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// Guess if a column key looks like a numeric/money/qty field
function guessNumFmt(key: string): string | null {
  const k = key.toLowerCase();
  // Exchange rates are tested first because their column names contain "rate",
  // which the money pattern below also matches: tested in the other order, a
  // rate stored to six decimals was displayed rounded to two, and the branch
  // written to prevent that never ran.
  if (/fx_rate|exchange_rate/.test(k)) {
    return "#,##0.000000";
  }
  if (
    /amount|total|balance|salary|rate|price|value|cost|revenue|profit|commission|fee|tax|discount|advance|bonus|deposit|withdrawal|payment|freight|duty|margin/.test(
      k
    )
  ) {
    return "#,##0.00";
  }
  if (/qty|quantity|weight|kg|count|bales|units|percentage|pct/.test(k)) {
    return "#,##0.###";
  }
  return null;
}

// Guess column width based on key name
function guessWidth(key: string): number {
  const k = key.toLowerCase();
  if (/narration|description|notes|message|address|changes|reason|error/.test(k)) return 45;
  if (/name|legal_name|email/.test(k)) return 28;
  if (/number|voucher_number|container_number|reference|barcode|code/.test(k)) return 22;
  if (/date|at|created|updated/.test(k)) return 22;
  if (/amount|total|balance|salary|value|cost|revenue|profit/.test(k)) return 18;
  return 16;
}

function formatValue(val: unknown) {
  if (val === null || val === undefined) return "";
  if (val instanceof Date) return val.toISOString().substring(0, 19).replace("T", " ");
  // Stringify objects/arrays (e.g. JSONB columns)
  if (typeof val === "object") return JSON.stringify(val);
  return val;
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function styleHeaderRow(ws: ExcelJS.Worksheet, colCount: number) {
  const hdr = ws.getRow(1);
  for (let i = 1; i <= colCount; i++) {
    const cell = hdr.getCell(i);
    cell.fill = HDR_FILL;
    cell.font = HDR_FONT;
    cell.border = { bottom: { style: "thin", color: { argb: "FF3B82F6" } } };
    cell.alignment = { vertical: "middle" };
  }
  hdr.height = 20;
}

// Auto-detect all columns from data rows and export every field.
// Empty sheets are created as hidden so they can be unhidden manually in Excel.
// NOTE: Per-cell fill and numFmt are intentionally avoided — they create one cell
// object per cell in the ExcelJS model, causing OOM crashes on large sheets.
// numFmt is applied at the column level (one shared style object per column).
export function addSheet(wb: ExcelJS.Workbook, name: string, rows: Record<string, unknown>[]) {
  const sheetBase = name.substring(0, 31);

  if (!rows || rows.length === 0) {
    const ws = wb.addWorksheet(sheetBase);
    ws.state = "hidden";
    return;
  }

  // Collect all unique keys across first 200 rows (handles sparse rows)
  const keysSet = new Set<string>();
  const sample = rows.slice(0, 200);
  for (const row of sample) {
    if (row && typeof row === "object") {
      for (const key of Object.keys(row)) keysSet.add(key);
    }
  }
  const keys = Array.from(keysSet);

  const columns = keys.map((key) => ({
    key,
    header: toHeader(key),
    width: guessWidth(key),
    numFmt: guessNumFmt(key),
  }));

  const chunks = chunkArray(rows, MAX_ROWS);
  chunks.forEach((chunk, idx) => {
    const sheetName = chunks.length > 1 ? `${name.substring(0, 28)} ${idx + 1}` : sheetBase;

    const ws = wb.addWorksheet(sheetName);

    // Set numFmt at column level — one shared style per column instead of one
    // cell object per row × column. Critical for keeping memory bounded.
    ws.columns = columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width,
      style: c.numFmt ? { numFmt: c.numFmt } : undefined,
    }));

    styleHeaderRow(ws, columns.length);

    // Plain row insertion — no per-cell styling to avoid O(rows × cols) objects.
    for (const row of chunk) {
      ws.addRow(columns.map((c) => formatValue(row[c.key])));
    }

    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  });
}
