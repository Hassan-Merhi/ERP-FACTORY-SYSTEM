import ExcelJS from "exceljs";
import { parseMoneyInput } from "../../lib/money";

// ── Public interface ──────────────────────────────────────────────────────────

export interface SpSalesFormParams {
  companyId: number;
  fromDate: string; // YYYY-MM-DD
  toDate: string; // YYYY-MM-DD
  supplierName?: string;
  locationName?: string; // used in filename
  locationId?: number; // optional; when provided, filters sales and opening stock to that location
}

// ── Internal types ────────────────────────────────────────────────────────────

export interface DaySales {
  qty: number;
  totalSales: number;
  totalCost: number;
  totalDeduction: number; // per-qty warehouse deduction from locations table
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function pn(v: unknown): number {
  const n = parseMoneyInput(String(v ?? "0"))?.toNumber() ?? NaN;
  return isNaN(n) ? 0 : n;
}
export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** YYYY-MM-DD → UTC midnight Date */
export function toUtcDate(s: string): Date {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86_400_000);
}

export function dateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Returns true if the cell holds an Excel formula (or a shared-formula reference).
 * ExcelJS represents master formula cells as { formula, result? }
 * and shared-formula slave cells as { sharedFormula: '<masterAddr>' }.
 * Both must be treated as formula cells so we never accidentally overwrite them
 * in contexts where we want to preserve the formula chain.
 */
export function isFormula(cell: ExcelJS.Cell): boolean {
  if (cell.value === null || cell.value === undefined) return false;
  if (typeof cell.value !== "object") return false;
  const v = cell.value as unknown as Record<string, unknown>;
  return "formula" in v || "sharedFormula" in v;
}

/**
 * Convert 1-based column number to Excel letter notation.
 * e.g. 1→A, 26→Z, 27→AA, 53→BA
 */
export function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    n--;
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26);
  }
  return s;
}

/**
 * Normalised lookup key: lowercase + collapse whitespace.
 * Used for case-insensitive, whitespace-tolerant item matching between
 * template display names and DB article codes / stock item names.
 */
export const nk = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Excel formula error strings we scan for after export. */
export const EXCEL_ERRORS = ["#REF!", "#DIV/0!", "#VALUE!", "#NAME?", "#N/A"];

// ── Template column / row constants ──────────────────────────────────────────

// ENTRY sheet
export const E_DATE_ROW = 3;
export const E_DATA_START = 5;
// E_DATA_END is resolved dynamically from entryWs.rowCount after template load.
// The template (55 Lubumbashi) has 173 rows; the old hardcoded 128 skipped items after that.
export const E_NAME_COL = 3; // C – display name (matches article_code / canonical stock code)
export const E_CODE_COL = 4; // D – optional system code override
export const E_OPENING_QTY_COL = 5; // E – Opening Stock qty  (written directly; never rely on Costing SUMIFS)
export const E_COST_BAG_COL = 6; // F – Avg Cost per Bag   (written directly; also $F ref in profit formula)
export const E_DATE_START = 7; // G – first date block
// Pattern per day d: baseCol = E_DATE_START + d*3
//   baseCol   = Qty          (plain)
//   baseCol+1 = Sale Price   (plain)
//   baseCol+2 = Profit/Bag   (formula – see below)
//
// Template date capacity: days 0-17 → cols G(7)–BI(60).  After that:
//   col 61 (BI+1) = empty separator
//   col 62 (BJ)   = Closing Stock Qty
//   col 63 (BK)   = Closing Stock Value
// The "beyond range" clearing loops MUST stop before col 61 to avoid wiping
// these fixed columns.
export const E_TEMPLATE_MAX_DAYS = 18; // number of date-day slots in this template
export const E_CLOSING_QTY_COL = 62; // BJ – Closing Stock Qty  (written directly)
export const E_CLOSING_VAL_COL = 63; // BK – Closing Stock Value (written directly)

// Costing sheet
export const C_NAME_COL = 4; // D – item name (same as ENTRY col C)
export const C_QTY_COL = 5; // E – On Hand qty  (opening stock)
export const C_AVG_COL = 7; // G – Avg Cost (formula =H/E – we write 0 when qty=0 to prevent #DIV/0!)
export const C_VAL_COL = 8; // H – Asset value  (opening value)

// Sales sheet
export const S_DATE_ROW = 1;
export const S_DATA_START = 2;
export const S_NAME_COL = 3; // C – item name
export const S_DATE_START = 6; // F – first date column
// Sales date row structure (confirmed from template):
//   F1 = plain date (day 0)
//   G1 = {formula:"F1+1"}, H1 = {formula:"G1+1"}, ..., L1 = {formula:"K1+1"}  (days 1–6)
//   M1 onward = plain stale dates (not chained)
// We must write F1 (day 0) and clear ALL cells from dayCount onward, including formula cells.

// ── Main export function ──────────────────────────────────────────────────────
