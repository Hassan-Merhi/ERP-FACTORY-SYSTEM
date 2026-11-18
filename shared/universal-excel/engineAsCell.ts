// Extracted from ./engine.ts to keep that module under the source-size cap.
import ExcelJS from "exceljs";
import type { UniversalExcelAppearance } from "./design";

export const UNIVERSAL_EXCEL_SCHEMA_VERSION = 1 as const;

export type UniversalExcelMode = "report" | "import-template";

export type UniversalExcelColumnType =
  "auto" | "text" | "integer" | "decimal" | "money" | "percentage" | "date" | "boolean" | "formula";

export type UniversalExcelRecord = Readonly<Record<string, unknown>>;

/** Formulas must be deliberately constructed by a trusted report builder. */
export interface TrustedExcelFormula {
  trustedFormula: string;
  result?: string | number | boolean | null;
}

export interface UniversalExcelColumn {
  key: string;
  header: string;
  type?: UniversalExcelColumnType;
  width?: number;
  numFmt?: string;
  /** Column is omitted unless the caller explicitly grants this tag. */
  permissionTag?: string;
  /** All additional tags are required, not alternatives. */
  permissionTags?: readonly string[];
  /** Validated for detail rows; footers may intentionally leave it blank. */
  required?: boolean;
  /**
   * Optional read-only accessor for derived/dimension columns. The returned
   * value uses this column's normal numeric/date/text validation.
   * A value accessor MUST declare every source record key it needs.
   */
  value?: (row: UniversalExcelRecord) => unknown;
  /** Raw data keys consumed by value(); also counted for strict validation. */
  sourceKeys?: readonly string[];
}

export interface UniversalExcelGroup {
  label: string;
  rows: readonly UniversalExcelRecord[];
  /** Precomputed by the page/ledger, never recalculated by this engine. */
  footer?: UniversalExcelRecord;
}

interface UniversalExcelSheetBase {
  name: string;
  /**
   * In report mode the default data header is row 5; in import-template mode
   * it is row 1. Overrides are exact, never silently shifted.
   */
  headerRow?: number;
  columns: readonly UniversalExcelColumn[];
  /** Additional page-defined fields such as per-location prices or months. */
  dynamicColumns?: readonly UniversalExcelColumn[];
  /**
   * Only discover keys in this explicit, already-authorized allowlist.
   * Search EVERY row (not only the first 200) for late/sparse values.
   * Keys not present in any row are not rendered.
   */
  discoverColumns?: readonly UniversalExcelColumn[];
  /** Reject any record keys not covered by the effective schema (default true). */
  strictColumns?: boolean;
  /** Optional rows before an import template's exact header row. */
  prefaceRows?: readonly (readonly unknown[])[];
  footer?: UniversalExcelRecord;
  autoFilter?: boolean;
  freezeHeader?: boolean;
}

export interface UniversalExcelTableSheet extends UniversalExcelSheetBase {
  kind: "table";
  rows: readonly UniversalExcelRecord[];
}

export interface UniversalExcelGroupedSheet extends UniversalExcelSheetBase {
  kind: "grouped";
  groups: readonly UniversalExcelGroup[];
}

/**
 * Escape hatch for invoice/matrix/print layouts whose original worksheet
 * contract must remain intact. This path deliberately applies no title rows,
 * filters, renaming, formulas, or other structural changes to the worksheet.
 */
export interface UniversalExcelCustomSheet {
  kind: "custom";
  name: string;
  build: (worksheet: ExcelJS.Worksheet) => void;
}

export type UniversalExcelSheet = UniversalExcelTableSheet | UniversalExcelGroupedSheet | UniversalExcelCustomSheet;

export interface UniversalExcelWorkbookSpec {
  schemaVersion: typeof UNIVERSAL_EXCEL_SCHEMA_VERSION;
  title: string;
  mode: UniversalExcelMode;
  sheets: readonly UniversalExcelSheet[];
  companyName?: string;
  currencyCode?: string;
  exportedAt?: Date;
  dateFormat?: "dd/mm/yyyy" | "mm/dd/yyyy";
  filters?: readonly { label: string; value: string }[];
  /**
   * Display-level safeguard only: all sensitive data must ALREADY have been
   * authorized and filtered at its API/data source.
   */
  allowedColumnTags?: readonly string[];
  /** Report-only design; import templates and custom sheets retain layouts. */
  appearance?: UniversalExcelAppearance;
}

export interface UniversalExcelSheetResult {
  name: string;
  kind: UniversalExcelSheet["kind"];
  headerRow: number | null;
  dataRows: number;
  columns: readonly string[];
}

export const MAX_EXCEL_ROWS = 1_048_576;

export const MAX_EXCEL_COLUMNS = 16_384;

export const NAVY = "FF1E3A5F";

const TEXT_FORMULA_PREFIX = /^\s*[=+@-]/u;

export function safeText(value: unknown): string {
  const raw = String(value ?? "");
  return TEXT_FORMULA_PREFIX.test(raw) ? "'" + raw : raw;
}

function toDate(value: unknown, key: string): Date {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("Invalid date in column " + key);
    return new Date(value.getTime());
  }
  // A date-only value is kept at local midnight, avoiding a TZ-dependent shift.
  const raw = String(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("Date column " + key + " requires YYYY-MM-DD or Date");
  }
  const year = Number(raw.slice(0, 4));
  const month = Number(raw.slice(5, 7));
  const day = Number(raw.slice(8, 10));
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error("Invalid date in column " + key);
  }
  return date;
}

function numeric(value: unknown, key: string, integer: boolean): number {
  const raw = typeof value === "string" ? value.trim() : value;
  if (
    typeof raw !== "number" &&
    (typeof raw !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))
  ) {
    throw new Error("Column " + key + " requires a numeric value");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error("Invalid numeric value in column " + key);
  }
  return parsed;
}

export function asCell(value: unknown, column: UniversalExcelColumn): ExcelJS.CellValue {
  if (value === null || value === undefined || value === "") return null;
  switch (column.type ?? "text") {
    case "auto":
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error("Invalid numeric value in column " + column.key);
        return value;
      }
      if (typeof value === "boolean") return value;
      if (value instanceof Date) return toDate(value, column.key);
      if (typeof value !== "string") throw new Error("Unsupported Excel cell value in " + column.key);
      return safeText(value);
    case "text":
      return safeText(value);
    case "integer":
      return numeric(value, column.key, true);
    case "decimal":
    case "money":
    case "percentage":
      return numeric(value, column.key, false);
    case "date":
      return toDate(value, column.key);
    case "boolean":
      if (typeof value !== "boolean") throw new Error("Column " + column.key + " requires a boolean");
      return value;
    case "formula": {
      if (
        typeof value !== "object" ||
        !("trustedFormula" in value) ||
        typeof value.trustedFormula !== "string" ||
        !value.trustedFormula.trim()
      ) {
        throw new Error("Column " + column.key + " requires a trusted formula object");
      }
      const formula = value as TrustedExcelFormula;
      if (
        formula.result !== undefined &&
        formula.result !== null &&
        typeof formula.result !== "number" &&
        typeof formula.result !== "string" &&
        typeof formula.result !== "boolean"
      ) {
        throw new Error("Invalid formula result in column " + column.key);
      }
      if (typeof formula.result === "number" && !Number.isFinite(formula.result)) {
        throw new Error("Invalid formula result in column " + column.key);
      }
      return { formula: formula.trustedFormula, ...(formula.result == null ? {} : { result: formula.result }) };
    }
  }
}

export function defaultNumFmt(
  type: UniversalExcelColumnType | undefined,
  dateFormat: UniversalExcelWorkbookSpec["dateFormat"]
): string | undefined {
  switch (type) {
    case "integer":
      return "#,##0";
    case "decimal":
      return "#,##0.###";
    case "money":
      return "#,##0.00";
    case "percentage":
      return "0.00%";
    case "date":
      return dateFormat ?? "dd/mm/yyyy";
    default:
      return undefined;
  }
}

export function assertSheetName(name: string, seen: Set<string>): void {
  if (
    !name ||
    name.length > 31 ||
    Array.from("\\/*?:[]").some((char) => name.includes(char)) ||
    name.startsWith("'") ||
    name.endsWith("'") ||
    seen.has(name.toLowerCase())
  ) {
    throw new Error("Invalid or duplicate Excel worksheet name: " + name);
  }
  seen.add(name.toLowerCase());
}

/** Iterate lazily; do not allocate a second array of a large export's rows. */
export function* sourceRows(
  sheet: UniversalExcelTableSheet | UniversalExcelGroupedSheet
): Generator<UniversalExcelRecord> {
  if (sheet.kind === "table") {
    yield* sheet.rows;
  } else {
    for (const group of sheet.groups) {
      yield* group.rows;
      if (group.footer) yield group.footer;
    }
  }
  if (sheet.footer) yield sheet.footer;
}
