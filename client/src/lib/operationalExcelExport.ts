/**
 * Opt-in adapter for existing ERP operational export buttons.
 *
 * This keeps existing record construction, company filters, permission
 * decisions, filenames and import-template headers in the caller. The helper
 * only wraps already-authorized records in the Phase 2–4 workbook engine.
 *
 * No export pagination happens here: callers MUST pass their complete
 * filtered dataset (not a single visible page).
 */
import type {
  UniversalExcelColumn,
  UniversalExcelMode,
  UniversalExcelRecord,
  UniversalExcelSheet,
  UniversalExcelSheetResult,
} from "@shared/universal-excel/engine";
import { downloadUniversalExcelWorkbook } from "@/lib/universalExcelExport";

export interface OperationalExcelSheet {
  name: string;
  columns: readonly UniversalExcelColumn[];
  rows: readonly UniversalExcelRecord[];
  /** An explicit subtotal or grand total, supplied by the existing page. */
  footer?: UniversalExcelRecord;
}

export interface OperationalExcelExportInput {
  title: string;
  fileName: string;
  companyName?: string;
  dateFormat?: "dd/mm/yyyy" | "mm/dd/yyyy";
  currencyCode?: string;
  mode?: UniversalExcelMode;
  sheets: readonly OperationalExcelSheet[];
  filters?: readonly { label: string; value: string }[];
  allowedColumnTags?: readonly string[];
}

/**
 * Discover the ordered union of existing object-row headers, not only row 1.
 * This is suitable for explicitly authorized legacy row objects, NOT raw API
 * database records or hidden-cost fields. A caller can override value types
 * for known numeric/date columns without changing the field names.
 */
export function columnsFromOperationalRows(
  rows: readonly UniversalExcelRecord[],
  options: {
    types?: Readonly<Record<string, UniversalExcelColumn["type"]>>;
    widths?: Readonly<Record<string, number>>;
    orderedHeaders?: readonly string[];
  } = {}
): UniversalExcelColumn[] {
  const keys = new Set(options.orderedHeaders ?? []);
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  if (!keys.size) throw new Error("Excel report has no columns; declare orderedHeaders for empty exports");
  return [...keys].map((key) => ({
    key,
    header: key,
    type: options.types?.[key] ?? "auto",
    width: options.widths?.[key] ?? 18,
  }));
}

export async function exportOperationalWorkbook(
  input: OperationalExcelExportInput
): Promise<UniversalExcelSheetResult[]> {
  if (!input.sheets.length) throw new Error("Excel operational export requires at least one sheet");
  const sheets: UniversalExcelSheet[] = input.sheets.map((sheet) => ({
    kind: "table",
    name: sheet.name,
    columns: sheet.columns,
    rows: sheet.rows,
    footer: sheet.footer,
    strictColumns: true,
  }));
  return downloadUniversalExcelWorkbook(
    {
      schemaVersion: 1,
      title: input.title,
      mode: input.mode ?? "report",
      companyName: input.companyName,
      dateFormat: input.dateFormat,
      currencyCode: input.currencyCode,
      filters: input.filters,
      allowedColumnTags: input.allowedColumnTags,
      sheets,
    },
    input.fileName
  );
}
