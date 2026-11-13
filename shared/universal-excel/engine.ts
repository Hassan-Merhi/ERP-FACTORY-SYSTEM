/**
 * Universal Excel Export Engine — Phase 2.
 *
 * Opt-in workbook builder shared by ERP, Factory, and Properties. The data
 * adapter must supply authorized, complete records; this is NOT a replacement
 * for endpoint authentication, company scoping, or cost-field authorization.
 *
 * Do not insert decorative report rows into import templates: many parsers
 * depend on the first worksheet and absolute cell/header coordinates.
 */
import ExcelJS from "exceljs";
import {
  applyUniversalExcelPrintLayout,
  paintExcelRow,
  resolveUniversalExcelAppearance,
  styleUniversalExcelGroup,
  styleUniversalExcelTotal,
  type ResolvedUniversalExcelAppearance,
  type UniversalExcelAppearance,
} from "./design";

export const UNIVERSAL_EXCEL_SCHEMA_VERSION = 1 as const;
export type UniversalExcelMode = "report" | "import-template";
export type UniversalExcelColumnType =
  | "auto"
  | "text"
  | "integer"
  | "decimal"
  | "money"
  | "percentage"
  | "date"
  | "boolean"
  | "formula";

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

export type UniversalExcelSheet =
  | UniversalExcelTableSheet
  | UniversalExcelGroupedSheet
  | UniversalExcelCustomSheet;

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

const MAX_EXCEL_ROWS = 1_048_576;
const MAX_EXCEL_COLUMNS = 16_384;
const NAVY = "FF1E3A5F";
const PALE = "FFEFF4FA";
const WHITE = "FFFFFFFF";
const TEXT_FORMULA_PREFIX = /^\s*[=+@-]/u;

function safeText(value: unknown): string {
  const raw = String(value ?? "");
  return TEXT_FORMULA_PREFIX.test(raw) ? "'" + raw : raw;
}

function displayDate(date: Date, format: UniversalExcelWorkbookSpec["dateFormat"]): string {
  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  return format === "mm/dd/yyyy"
    ? month + "/" + day + "/" + year
    : day + "/" + month + "/" + year;
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
  if (typeof raw !== "number" && (typeof raw !== "string" || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(raw))) {
    throw new Error("Column " + key + " requires a numeric value");
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || (integer && !Number.isSafeInteger(parsed))) {
    throw new Error("Invalid numeric value in column " + key);
  }
  return parsed;
}

function asCell(value: unknown, column: UniversalExcelColumn): ExcelJS.CellValue {
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
      if (typeof value !== "object" || !("trustedFormula" in value) ||
          typeof value.trustedFormula !== "string" || !value.trustedFormula.trim()) {
        throw new Error("Column " + column.key + " requires a trusted formula object");
      }
      const formula = value as TrustedExcelFormula;
      if (formula.result !== undefined && formula.result !== null &&
          typeof formula.result !== "number" && typeof formula.result !== "string" &&
          typeof formula.result !== "boolean") {
        throw new Error("Invalid formula result in column " + column.key);
      }
      if (typeof formula.result === "number" && !Number.isFinite(formula.result)) {
        throw new Error("Invalid formula result in column " + column.key);
      }
      return { formula: formula.trustedFormula, ...(formula.result == null ? {} : { result: formula.result }) };
    }
  }
}

function defaultNumFmt(type: UniversalExcelColumnType | undefined, dateFormat: UniversalExcelWorkbookSpec["dateFormat"]): string | undefined {
  switch (type) {
    case "integer": return "#,##0";
    case "decimal": return "#,##0.###";
    case "money": return "#,##0.00";
    case "percentage": return "0.00%";
    case "date": return dateFormat ?? "dd/mm/yyyy";
    default: return undefined;
  }
}

function assertSheetName(name: string, seen: Set<string>): void {
  if (!name || name.length > 31 || Array.from("\\/*?:[]").some(char => name.includes(char)) ||
      name.startsWith("'") || name.endsWith("'") || seen.has(name.toLowerCase())) {
    throw new Error("Invalid or duplicate Excel worksheet name: " + name);
  }
  seen.add(name.toLowerCase());
}

/** Iterate lazily; do not allocate a second array of a large export's rows. */
function* sourceRows(
  sheet: UniversalExcelTableSheet | UniversalExcelGroupedSheet,
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

function resolveColumns(
  sheet: UniversalExcelTableSheet | UniversalExcelGroupedSheet,
  allowed: ReadonlySet<string>,
): UniversalExcelColumn[] {
  const present = new Set<string>();
  for (const row of sourceRows(sheet)) {
    for (const key of Object.keys(row)) present.add(key);
  }
  const selected: UniversalExcelColumn[] = [];
  const seen = new Set<string>();
  const coveredSourceKeys = new Set<string>();
  const discovered = (sheet.discoverColumns ?? []).filter(column =>
    present.has(column.key) || column.sourceKeys?.some(key => present.has(key))
  );
  for (const column of [...sheet.columns, ...(sheet.dynamicColumns ?? []), ...discovered]) {
    if (!column.key.trim() || !column.header.trim() || seen.has(column.key) ||
        (column.width != null && (!Number.isFinite(column.width) || column.width <= 0)) ||
        (column.value && !column.sourceKeys?.length) ||
        column.sourceKeys?.some(key => !key.trim()) ||
        column.permissionTags?.some(tag => !tag.trim())) {
      throw new Error("Invalid or duplicate column: " + column.key);
    }
    seen.add(column.key);
    coveredSourceKeys.add(column.key);
    for (const key of column.sourceKeys ?? []) coveredSourceKeys.add(key);
    if (column.permissionTag && !allowed.has(column.permissionTag)) continue;
    if (column.permissionTags?.some(tag => !allowed.has(tag))) continue;
    selected.push(column);
  }
  if (selected.length === 0 || selected.length > MAX_EXCEL_COLUMNS) {
    throw new Error("Excel sheet must contain 1 to 16384 visible columns");
  }
  if (sheet.strictColumns !== false) {
    // Keys blocked by permission are allowed in source only to avoid leaking
    // their contents into the output. Unrecognized fields fail rather than
    // silently disappearing (even if they only occur after row 200).
    for (const key of present) {
      if (!coveredSourceKeys.has(key)) throw new Error("Unmapped Excel export column: " + key + " in " + sheet.name);
    }
  }
  return selected;
}

function writeRow(
  worksheet: ExcelJS.Worksheet,
  rowNumber: number,
  columns: readonly UniversalExcelColumn[],
  data: UniversalExcelRecord,
  validateRequired = true,
): void {
  const row = worksheet.getRow(rowNumber);
  for (let i = 0; i < columns.length; i += 1) {
    const column = columns[i];
    const value = column.value ? column.value(data) : data[column.key];
    if (validateRequired && columns[i].required && (value === undefined || value === null || value === "")) {
      throw new Error("Missing required Excel value for " + columns[i].key + " at row " + rowNumber);
    }
    row.getCell(i + 1).value = asCell(value, columns[i]);
  }
}

function fillRow(worksheet: ExcelJS.Worksheet, rowNumber: number, count: number, color: string): void {
  const row = worksheet.getRow(rowNumber);
  for (let i = 1; i <= count; i += 1) {
    row.getCell(i).fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
  }
}

function styleHeader(
  ws: ExcelJS.Worksheet,
  rowNumber: number,
  columns: readonly UniversalExcelColumn[],
  design?: ResolvedUniversalExcelAppearance,
): void {
  const row = ws.getRow(rowNumber);
  row.height = design ? 28 : 24;
  for (let i = 0; i < columns.length; i += 1) {
    const cell = row.getCell(i + 1);
    cell.value = safeText(columns[i].header);
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: design?.palette.primary ?? NAVY } };
    cell.font = {
      name: "Aptos",
      bold: true,
      color: { argb: design?.palette.onPrimary ?? WHITE },
      size: 10,
    };
    cell.alignment = {
      horizontal: columns[i].type === "integer" || columns[i].type === "decimal" ||
        columns[i].type === "money" || columns[i].type === "percentage" ? "right" : "left",
      vertical: "middle",
      wrapText: true,
    };
  }
}

function styleMetadata(
  ws: ExcelJS.Worksheet,
  spec: UniversalExcelWorkbookSpec,
  width: number,
  design: ResolvedUniversalExcelAppearance,
): void {
  const timestamp = spec.exportedAt ?? new Date();
  if (!Number.isFinite(timestamp.getTime())) throw new Error("Invalid export timestamp");
  const parts = [
    spec.companyName ? "Company: " + spec.companyName : "",
    spec.currencyCode ? "Currency: " + spec.currencyCode : "",
    "Exported: " + displayDate(timestamp, spec.dateFormat),
  ].filter(Boolean);
  const filters = (spec.filters ?? []).map(f => f.label + ": " + f.value).join(" | ");
  if (width > 1) ws.mergeCells(1, 1, 1, width);
  ws.getCell(1, 1).value = safeText(spec.title);
  ws.getCell(1, 1).font = {
    name: "Aptos Display", bold: true, color: { argb: design.palette.onPrimary }, size: 16,
  };
  paintExcelRow(ws, 1, width, design.palette.primary);
  ws.getRow(1).height = 34;
  if (width > 1) ws.mergeCells(2, 1, 2, width);
  ws.getCell(2, 1).value = safeText(parts.join(" | "));
  if (width > 1) ws.mergeCells(3, 1, 3, width);
  ws.getCell(3, 1).value = safeText(filters ? "Filters: " + filters : "Filters: All");
  ws.getCell(2, 1).font = { name: "Aptos", size: 10, color: { argb: design.palette.bodyText } };
  ws.getCell(3, 1).font = { name: "Aptos", size: 9, color: { argb: design.palette.mutedText }, italic: true };
  ws.getRow(2).height = 20;
  ws.getRow(3).height = 19;
  if (design.showBranding) {
    if (width > 1) ws.mergeCells(4, 1, 4, width);
    ws.getCell(4, 1).value = safeText(design.brandName);
    ws.getCell(4, 1).font = {
      name: "Aptos", size: 9, bold: true, color: { argb: design.palette.primary },
    };
    ws.getRow(4).height = 20;
  }
}

function renderDataSheet(
  workbook: ExcelJS.Workbook,
  spec: UniversalExcelWorkbookSpec,
  sheet: UniversalExcelTableSheet | UniversalExcelGroupedSheet,
  allowed: ReadonlySet<string>,
): UniversalExcelSheetResult {
  const cols = resolveColumns(sheet, allowed);
  const design = spec.mode === "report" ? resolveUniversalExcelAppearance(spec.appearance) : undefined;
  const headerRow = sheet.headerRow ?? (spec.mode === "import-template" ? 1 : 5);
  if (!Number.isSafeInteger(headerRow) || headerRow < (spec.mode === "report" ? 5 : 1)) {
    throw new Error("Invalid header position for " + sheet.name);
  }
  if (spec.mode === "report" && sheet.prefaceRows?.length) {
    throw new Error("Preface rows are reserved for import templates");
  }
  if ((sheet.prefaceRows?.length ?? 0) >= headerRow) {
    throw new Error("Preface rows overlap the import header in " + sheet.name);
  }
  const ws = workbook.addWorksheet(sheet.name);
  if (design) styleMetadata(ws, spec, cols.length, design);
  for (let i = 0; i < (sheet.prefaceRows?.length ?? 0); i += 1) {
    const preface = sheet.prefaceRows![i];
    if (preface.length > cols.length) throw new Error("Preface width exceeds column count");
    for (let j = 0; j < preface.length; j += 1) {
      ws.getRow(i + 1).getCell(j + 1).value = safeText(preface[j]);
    }
  }
  for (let i = 0; i < cols.length; i += 1) {
    const col = ws.getColumn(i + 1);
    col.width = cols[i].width ?? 18;
    col.numFmt = cols[i].numFmt ?? defaultNumFmt(cols[i].type, spec.dateFormat) ?? "General";
    if (design) {
      const numericColumn = ["integer", "decimal", "money", "percentage", "formula"].includes(cols[i].type ?? "");
      col.alignment = {
        vertical: "middle",
        horizontal: numericColumn ? "right" : cols[i].type === "date" ? "center" : "left",
      };
    }
  }
  styleHeader(ws, headerRow, cols, design);
  let next = headerRow + 1;
  let count = 0;
  let lastDataRow = headerRow;
  let detailRowIndex = 0;
  const detailCount = sheet.kind === "table"
    ? sheet.rows.length
    : sheet.groups.reduce((total, group) => total + group.rows.length, 0);
  // Uniformly skip zebra fills on large reports; no partial styling and no
  // millions of unnecessary per-cell style allocations.
  const useAlternating = design !== undefined && design.alternateRows &&
    detailCount <= design.maxAlternatingRows;
  const put = (record: UniversalExcelRecord, validateRequired = true, isDetail = true) => {
    if (next > MAX_EXCEL_ROWS) throw new Error("Excel worksheet row limit exceeded: " + sheet.name);
    writeRow(ws, next, cols, record, validateRequired);
    if (isDetail) {
      if (useAlternating && (detailRowIndex % 2) === 1) {
        paintExcelRow(ws, next, cols.length, design!.palette.alternating);
      }
      detailRowIndex += 1;
    }
    lastDataRow = next++;
    count += 1;
  };
  const footer = (record: UniversalExcelRecord, kind: "subtotal" | "grand-total") => {
    put(record, false, false);
    if (design) {
      styleUniversalExcelTotal(ws, next - 1, cols.length, design, kind);
    } else {
      const footerRow = ws.getRow(next - 1);
      footerRow.font = { bold: true, color: { argb: NAVY } };
      fillRow(ws, next - 1, cols.length, PALE);
    }
  };
  if (sheet.kind === "table") {
    for (const record of sheet.rows) put(record);
  } else {
    for (const group of sheet.groups) {
      if (next > MAX_EXCEL_ROWS) throw new Error("Excel worksheet row limit exceeded: " + sheet.name);
      const rowNo = next++;
      if (cols.length > 1) ws.mergeCells(rowNo, 1, rowNo, cols.length);
      const groupCell = ws.getRow(rowNo).getCell(1);
      groupCell.value = safeText(group.label);
      if (design) {
        styleUniversalExcelGroup(ws, rowNo, cols.length, design);
      } else {
        groupCell.font = { bold: true, color: { argb: NAVY } };
        groupCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: PALE } };
      }
      detailRowIndex = 0;
      for (const record of group.rows) put(record);
      if (group.footer) footer(group.footer, "subtotal");
    }
  }
  if (sheet.footer) footer(sheet.footer, "grand-total");
  const enableFilter = sheet.autoFilter ?? (spec.mode === "report" && sheet.kind === "table");
  if (enableFilter) {
    ws.autoFilter = {
      from: { row: headerRow, column: 1 },
      to: { row: Math.max(headerRow, lastDataRow - (sheet.footer ? 1 : 0)), column: cols.length },
    };
  }
  if (sheet.freezeHeader ?? spec.mode === "report") {
    ws.views = [{ state: "frozen", xSplit: 0, ySplit: headerRow }];
  }
  if (design) {
    applyUniversalExcelPrintLayout(ws, {
      title: spec.title, headerRow, lastRow: next - 1, columnCount: cols.length, design,
    });
  }
  return { name: sheet.name, kind: sheet.kind, headerRow, dataRows: count, columns: cols.map(c => c.key) };
}

/**
 * Builds a new workbook but performs NO I/O. Server and client adapters must
 * reuse their established safe ExcelJS writing paths.
 */
export function buildUniversalExcelWorkbook(spec: UniversalExcelWorkbookSpec): {
  workbook: ExcelJS.Workbook;
  results: UniversalExcelSheetResult[];
} {
  if (spec.schemaVersion !== UNIVERSAL_EXCEL_SCHEMA_VERSION ||
      !spec.title.trim() || !spec.sheets.length || !["report", "import-template"].includes(spec.mode)) {
    throw new Error("Invalid universal Excel export specification");
  }
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dakzo Systems";
  workbook.created = spec.exportedAt ?? new Date();
  const names = new Set<string>();
  const allowed = new Set(spec.allowedColumnTags ?? []);
  const results: UniversalExcelSheetResult[] = [];
  for (const sheet of spec.sheets) {
    assertSheetName(sheet.name, names);
    if (sheet.kind === "custom") {
      // Custom layouts retain exact structure; the caller controls its
      // permissions and must supply already-authorized data.
      sheet.build(workbook.addWorksheet(sheet.name));
      results.push({ name: sheet.name, kind: "custom", headerRow: null, dataRows: 0, columns: [] });
      continue;
    }
    results.push(renderDataSheet(workbook, spec, sheet, allowed));
  }
  return { workbook, results };
}
