import { format } from "date-fns";

import { downloadBlob } from "@/lib/downloadBlob";

export type ErpReportFileExtension = "xlsx" | "csv";

/**
 * Filename-only normalization. Never change the display title, worksheet
 * values or any accounting number to generate a download filename.
 */
export function erpReportFileName(
  label: string,
  extension: ErpReportFileExtension,
  date: Date = new Date(),
  separator: "_" | "-" = "_"
): string {
  // Strip control characters without a control-character regex (lint gate).
  const safeCharacters = Array.from(label, (character) => (character.charCodeAt(0) < 32 ? "_" : character)).join("");
  const prefix =
    safeCharacters
      .replace(/[\\/<>:"|?*]+/g, "_")
      .replace(/[.\s]+$/g, "")
      .trim() || "ERP_Report";
  return `${prefix}${separator}${format(date, "yyyy-MM-dd")}.${extension}`;
}

/** Existing ExcelJS worksheet compatibility (headers and values unchanged). */
export async function exportErpReportRowsExcel<Row extends object>({
  rows,
  sheetName,
  fileName,
  universalDesign = false,
  companyName,
}: {
  rows: readonly Row[];
  sheetName: string;
  fileName: string;
  /** Opt in per report; false keeps legacy first-row contracts unchanged. */
  universalDesign?: boolean;
  companyName?: string;
}): Promise<void> {
  if (universalDesign && rows.length > 0) {
    const { columnsFromOperationalRows, exportOperationalWorkbook } = await import("@/lib/operationalExcelExport");
    const records = rows as unknown as readonly Record<string, unknown>[];
    await exportOperationalWorkbook({
      title: sheetName,
      companyName,
      fileName,
      sheets: [
        {
          name: sheetName,
          columns: columnsFromOperationalRows(records),
          rows: records,
        },
      ],
    });
    return;
  }
  // Legacy path remains the default (and handles empty exports).
  // ExcelJS is large; keep it out of the default ERP route bundles.
  const { utils, writeFile } = await import("@/lib/excelHelper");
  const wb = utils.book_new();
  utils.book_append_sheet(wb, utils.json_to_sheet([...rows]), sheetName);
  await writeFile(wb, fileName);
}

/**
 * Shared standards-compliant CSV serialization; numerics remain numeric
 * in the source data. Escape formula-leading *text* to prevent opening a
 * user-provided name or note as a spreadsheet formula.
 */
export function buildErpReportCsv(headers: readonly string[], rows: readonly (readonly unknown[])[]): string {
  const safeCell = (value: unknown): string => {
    const raw = value == null ? "" : String(value);
    const trimmed = raw.trim();
    const numericText = /^-?\d+(?:\.\d+)?$/.test(trimmed);
    const formulaLike = /^[\s\uFEFF]*[=+@\-\t\r]/u.test(raw);
    const guarded = typeof value === "string" && formulaLike && !numericText ? `'${raw}` : raw;
    return `"${guarded.replace(/"/g, '""')}"`;
  };
  const lines = headers.length > 0 ? [headers, ...rows] : rows;
  return lines.map((row) => row.map(safeCell).join(",")).join("\r\n");
}

/** Does not download partial UI slices; caller supplies the full filtered rows. */
export function exportErpReportCsv({
  headers,
  rows,
  fileName,
}: {
  headers: readonly string[];
  rows: readonly (readonly unknown[])[];
  fileName: string;
}): void {
  const csv = buildErpReportCsv(headers, rows);
  downloadBlob(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }), fileName);
}
