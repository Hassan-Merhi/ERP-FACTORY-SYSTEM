// Extracted from ./factorySheetsRoutes.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { factorySheets } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { spreadsheetUpload } from "../helpers/uploadHelpers";
import xlsxStyle from "xlsx-js-style";
import { parseMoneyInput } from "../../lib/money";

export const { read: readExcel, utils: xlsxUtils, write: writeExcel } = xlsxStyle;

export const upload = spreadsheetUpload;

// ── STATUS sheet helpers ───────────────────────────────────────────────────────
type CellVal = number | string | null;

/** Raw cell values as produced by xlsx: dates/booleans also occur despite `defval: null`. */
export type RawCell = number | string | boolean | Date | null | undefined;

export type SRow = { id?: string; label: string; cells: number[] };

type SSheet = { id?: number; name: string; columns: unknown[]; rows: SRow[]; orderIndex?: number };

export const STATUS_NAME = "STATUS";

// Support both old format (string) and new format ({ id, label })
export function getColLabel(col: unknown): string {
  if (typeof col === "string") return col;
  if (col && typeof col === "object" && "label" in col) {
    const label = (col as { label?: unknown }).label;
    return typeof label === "string" ? label : "";
  }
  return "";
}

// Support both old format (primitive) and new format ({ value, link? })
export function getCellRawValue(cell: unknown): CellVal {
  if (cell === null || cell === undefined) return null;
  if (typeof cell === "number" || typeof cell === "string") return cell;
  if (typeof cell === "object" && "value" in cell) {
    const value = (cell as { value?: unknown }).value;
    if (value === null || value === undefined) return null;
    if (typeof value === "number" || typeof value === "string") return value;
    return String(value);
  }
  return null;
}

function toNumber(v: CellVal): number {
  if (typeof v === "number") return isNaN(v) ? 0 : v;
  if (typeof v === "string") {
    return parseMoneyInput(v.replace(/,/g, ""))?.toNumber() ?? 0;
  }
  return 0;
}

function findSheet(sheets: SSheet[], name: string): SSheet | undefined {
  const n = name.trim().toLowerCase();
  return sheets.find((s) => s.name.trim().toLowerCase().includes(n));
}

function findColumnIndex(sheet: SSheet, names: string[]): number {
  for (const name of names) {
    const n = name.trim().toLowerCase();
    const idx = sheet.columns.findIndex((c) => getColLabel(c).trim().toLowerCase() === n);
    if (idx !== -1) return idx;
  }
  return -1;
}

function sumColumn(sheet: SSheet | undefined, names: string[]): number {
  if (!sheet) return 0;
  const idx = findColumnIndex(sheet, names);
  if (idx === -1) return 0;
  return sheet.rows.reduce((sum, row) => sum + toNumber(getCellRawValue(row.cells[idx])), 0);
}

function buildStatusSheet(sheets: SSheet[], existingStatus?: SSheet): { columns: string[]; rows: SRow[] } {
  // Read persisted BEFORE values from the existing STATUS sheet (so edits survive recalc)
  const getExistingBefore = (labelFragment: string, defaultVal: number): number => {
    if (!existingStatus) return defaultVal;
    const beforeIdx = findColumnIndex(existingStatus, ["BEFORE"]);
    if (beforeIdx === -1) return defaultVal;
    const row = existingStatus.rows.find((r) => r.label.trim().toLowerCase().includes(labelFragment.toLowerCase()));
    if (!row) return defaultVal;
    const v = toNumber(getCellRawValue(row.cells[beforeIdx]));
    return v !== 0 ? v : defaultVal;
  };

  // Source sheets
  const prodSheet = findSheet(sheets, "PRODUCTION");
  const stockSheet = findSheet(sheets, "STOCK IN");
  const ioSheet = findSheet(sheets, "IO");

  // DIFF values
  const prodDiff = -Math.abs(sumColumn(prodSheet, ["DIFF", "Diff", "فرق"]));
  const stockDiff = -Math.abs(sumColumn(stockSheet, ["فرق", "DIFF", "Diff"]));
  const ioDiff = sumColumn(ioSheet, ["WEIGHT", "Weight"]);

  // BEFORE values
  const prodBefore = getExistingBefore("PRODUCTION", -183221);
  const stockBefore = getExistingBefore("STOCK IN", -46020);
  const ioBefore = getExistingBefore("IO", -69011);

  // AFTER = BEFORE + DIFF
  const prodAfter = prodBefore + prodDiff;
  const stockAfter = stockBefore + stockDiff;
  const ioAfter = ioBefore + ioDiff;

  // DIFFERENCE totals row
  const totalBefore = prodBefore + stockBefore + ioBefore;
  const totalDiff = prodDiff + stockDiff + ioDiff;
  const totalAfter = prodAfter + stockAfter + ioAfter;

  const columns = ["BEFORE", "DIFF", "AFTER"];
  const rows: SRow[] = [
    { id: "status_row_production", label: "PRODUCTION اجراء اعمال", cells: [prodBefore, prodDiff, prodAfter] },
    { id: "status_row_stockin", label: "STOCK IN", cells: [stockBefore, stockDiff, stockAfter] },
    { id: "status_row_io", label: "IO", cells: [ioBefore, ioDiff, ioAfter] },
    { id: "status_row_difference", label: "DIFFERENCE", cells: [totalBefore, totalDiff, totalAfter] },
  ];

  return { columns, rows };
}

// Upsert the STATUS sheet for a company, always at orderIndex 0.
// Pass in already-fetched source sheets to avoid redundant DB calls.
export async function upsertStatusSheet(companyId: number, sourceSheets: SSheet[]): Promise<void> {
  // Exclude STATUS itself from source data
  const nonStatus = sourceSheets.filter((s) => s.name.trim().toUpperCase() !== STATUS_NAME);

  // Find the existing STATUS record so we can preserve BEFORE values
  const existingStatus = sourceSheets.find((s) => s.name.trim().toUpperCase() === STATUS_NAME);

  const { columns, rows } = buildStatusSheet(nonStatus, existingStatus);

  if (existingStatus?.id) {
    // Update in place
    await db
      .update(factorySheets)
      .set({ columns, rows, orderIndex: 0, updatedAt: new Date() })
      .where(and(eq(factorySheets.id, existingStatus.id), eq(factorySheets.companyId, companyId)));
  } else {
    // Push all existing sheets up by 1 to make room
    const allSheets = await db
      .select({ id: factorySheets.id, orderIndex: factorySheets.orderIndex })
      .from(factorySheets)
      .where(eq(factorySheets.companyId, companyId));

    for (const s of allSheets) {
      await db
        .update(factorySheets)
        .set({ orderIndex: s.orderIndex + 1 })
        .where(and(eq(factorySheets.id, s.id), eq(factorySheets.companyId, companyId)));
    }

    // Insert STATUS as first
    await db.insert(factorySheets).values({
      companyId,
      name: STATUS_NAME,
      orderIndex: 0,
      columns,
      rows,
    });
  }
}
