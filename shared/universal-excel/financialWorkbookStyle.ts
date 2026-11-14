/**
 * Phase 7 — nonstructural financial workbook design bridge.
 *
 * Financial exports may contain historical DR/CR balance formulas, currency
 * detail tabs, conditional status colors and exact-position rent/payment rows.
 * This adapter NEVER changes their values, formulas, numeric formats, row or
 * sheet positions, worksheet names, merged ranges or financial signs.
 */
import type ExcelJS from "exceljs";
import { resolveUniversalExcelAppearance, type UniversalExcelAppearance } from "./design";

export interface FinancialSheetAppearance {
  name: string;
  /** Header must already exist. Omit for variable-layout statements. */
  headerRow?: number;
  /** Existing title row; no new data or merged cells are added. */
  titleRow?: number;
  /** Preserve debit/credit/status-specific header fill. */
  preserveHeaderFill?: boolean;
}

export function styleUniversalFinancialWorkbook(
  workbook: ExcelJS.Workbook,
  layouts: readonly FinancialSheetAppearance[],
  appearance?: UniversalExcelAppearance
): void {
  const design = resolveUniversalExcelAppearance(appearance);
  workbook.creator = design.brandName;
  const seen = new Set<string>();
  for (const layout of layouts) {
    if (seen.has(layout.name)) throw new Error("Duplicate financial worksheet style: " + layout.name);
    seen.add(layout.name);
    const ws = workbook.getWorksheet(layout.name);
    if (!ws) throw new Error("Financial worksheet not found: " + layout.name);
    if (layout.headerRow !== undefined) {
      if (!Number.isSafeInteger(layout.headerRow) || layout.headerRow < 1 || layout.headerRow > ws.rowCount) {
        throw new Error("Invalid financial worksheet header position");
      }
      const row = ws.getRow(layout.headerRow);
      if (!row.cellCount) throw new Error("Financial worksheet header is empty");
      row.height = Math.max(22, row.height || 0);
      for (let i = 1; i <= row.cellCount; i += 1) {
        const cell = row.getCell(i);
        if (cell.value === null || cell.value === undefined) continue;
        if (!layout.preserveHeaderFill) {
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: design.palette.primary } };
        }
        cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: design.palette.onPrimary } };
        cell.alignment = { ...cell.alignment, vertical: "middle", wrapText: true };
      }
    }
    if (layout.titleRow !== undefined) {
      if (
        !Number.isSafeInteger(layout.titleRow) ||
        layout.titleRow < 1 ||
        layout.titleRow > ws.rowCount ||
        (layout.headerRow !== undefined && layout.titleRow === layout.headerRow)
      ) {
        throw new Error("Invalid financial worksheet title position");
      }
      const cell = ws.getRow(layout.titleRow).getCell(1);
      if (cell.value !== undefined && cell.value !== null) {
        cell.font = { name: "Aptos Display", size: 15, bold: true, color: { argb: design.palette.primary } };
      }
    }
    // A print header is metadata, not a row. Existing headers, audit footers,
    // freeze panes, print ranges, cash/accounting signs and formatting survive.
    if (design.printLayout && design.showBranding && !ws.headerFooter?.oddHeader) {
      ws.headerFooter.oddHeader = "&L" + (design.headerText || design.brandName).replaceAll("&", "");
      if (design.footerText && !ws.headerFooter.oddFooter) ws.headerFooter.oddFooter = "&L" + design.footerText;
    }
  }
}
