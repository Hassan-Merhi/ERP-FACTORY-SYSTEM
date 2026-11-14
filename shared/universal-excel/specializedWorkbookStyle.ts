/**
 * Phase 8 — appearance adapter for non-tabular, formula-driven and
 * import-compatible workbooks.
 *
 * This only updates workbook metadata, optional existing report header cells,
 * and empty print headers. It MUST NOT change cells, formulas, merges, row
 * numbers, sheet visibility, protection, data validations, native number
 * formats, pictures, or the workbook's calculation setting.
 *
 * An import template gets *no worksheet mutation at all* — only creator
 * metadata — because external importers often depend on absolute cell
 * positions and their surrounding print/layout properties.
 */
import type ExcelJS from "exceljs";
import { resolveUniversalExcelAppearance, type UniversalExcelAppearance } from "./design";

export type SpecializedSheetPurpose = "report" | "import-template" | "formula-support";

export interface SpecializedWorkbookSheet {
  name: string;
  purpose?: SpecializedSheetPurpose;
  /** Optional existing header row, never insert a new row. */
  headerRow?: number;
  /** Apply the shared accent to existing header cells only if explicitly safe. */
  brandHeader?: boolean;
  /** Never replace existing print headers or footers. */
  printBrand?: boolean;
}

export interface SpecializedWorkbookStyleOptions {
  /** When supplied, require exact sheet order, including hidden support tabs. */
  expectedSheetNames?: readonly string[];
  sheets?: readonly SpecializedWorkbookSheet[];
  appearance?: UniversalExcelAppearance;
}

export function styleSpecializedWorkbook(
  workbook: ExcelJS.Workbook,
  options: SpecializedWorkbookStyleOptions = {}
): void {
  const design = resolveUniversalExcelAppearance(options.appearance);
  const existing = workbook.worksheets.map((sheet) => sheet.name);
  if (
    options.expectedSheetNames !== undefined &&
    (existing.length !== options.expectedSheetNames.length ||
      existing.some((name, index) => name !== options.expectedSheetNames![index]))
  ) {
    throw new Error("Specialized workbook sheet order changed");
  }
  const seen = new Set<string>();
  const sheetSettings = options.sheets ?? [];
  // Validate all directives before applying any style changes.
  for (const settings of sheetSettings) {
    if (seen.has(settings.name)) throw new Error("Duplicate specialized workbook sheet: " + settings.name);
    seen.add(settings.name);
    const ws = workbook.getWorksheet(settings.name);
    if (!ws) throw new Error("Specialized workbook sheet not found: " + settings.name);
    if (settings.brandHeader) {
      if (
        settings.purpose !== "report" ||
        !Number.isSafeInteger(settings.headerRow) ||
        (settings.headerRow ?? 0) < 1 ||
        (settings.headerRow ?? 0) > ws.rowCount ||
        ws.getRow(settings.headerRow!).cellCount === 0
      ) {
        throw new Error("Invalid specialized report header position");
      }
    }
    if (settings.purpose === "import-template" && (settings.brandHeader || settings.printBrand)) {
      throw new Error("Import template layout must not be restyled");
    }
    if (settings.purpose === "formula-support" && settings.brandHeader) {
      throw new Error("Hidden formula support cannot be restyled");
    }
  }

  workbook.creator = design.brandName;
  for (const settings of sheetSettings) {
    const ws = workbook.getWorksheet(settings.name)!;
    const purpose = settings.purpose ?? "report";
    if (purpose === "import-template" || purpose === "formula-support") continue;
    // Existing report colors are intentionally preserved by default. Table
    // reports use the regular engine, not this specialized adapter.
    if (settings.brandHeader) {
      const row = ws.getRow(settings.headerRow!);
      row.height = Math.max(row.height || 0, 23);
      for (let col = 1; col <= row.cellCount; col += 1) {
        const cell = row.getCell(col);
        if (cell.value === null || cell.value === undefined) continue;
        cell.font = {
          ...cell.font,
          name: "Aptos",
          bold: true,
          color: { argb: design.palette.onPrimary },
        };
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: design.palette.primary },
        };
      }
    }
    if (settings.printBrand !== false && design.showBranding && ws.state === "visible" && !ws.headerFooter.oddHeader) {
      ws.headerFooter.oddHeader = "&L" + design.brandName.replaceAll("&", "");
    }
  }
}
