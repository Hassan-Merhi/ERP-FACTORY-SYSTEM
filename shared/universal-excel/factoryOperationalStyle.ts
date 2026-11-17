/**
 * Phase 6 Factory layout bridge. Styles legacy/special-purpose operational
 * sheets WITHOUT inserting, deleting, merging or moving any cell.
 *
 * Use the full universal workbook builder for ordinary tabular reports.
 * Use this bridge for attendance, production, and dispatch workbooks whose
 * formulas, print ranges, group positions or import coordinates are fixed.
 */
import type ExcelJS from "exceljs";
import { resolveUniversalExcelAppearance, type UniversalExcelAppearance } from "./design";

export interface FactoryOperationalSheetLayout {
  name: string;
  headerRow: number;
  /** Existing title cell at A{titleRow}; never create a title row. */
  titleRow?: number;
  /** Keep warning/success header background colors already meaningful. */
  preserveHeaderFill?: boolean;
}

export function styleFactoryOperationalWorkbook(
  workbook: ExcelJS.Workbook,
  layouts: readonly FactoryOperationalSheetLayout[],
  appearance?: UniversalExcelAppearance
): void {
  const design = resolveUniversalExcelAppearance(appearance);
  workbook.creator = design.brandName;
  const seen = new Set<string>();
  for (const layout of layouts) {
    if (seen.has(layout.name)) throw new Error("Duplicate Factory style sheet: " + layout.name);
    seen.add(layout.name);
    const ws = workbook.getWorksheet(layout.name);
    if (!ws) throw new Error("Factory style sheet not found: " + layout.name);
    if (!Number.isSafeInteger(layout.headerRow) || layout.headerRow < 1 || layout.headerRow > ws.rowCount) {
      throw new Error("Invalid Factory header position");
    }
    const row = ws.getRow(layout.headerRow);
    row.height = Math.max(23, row.height || 0);
    const cells = row.cellCount;
    if (cells === 0) throw new Error("Factory header row is empty");
    for (let c = 1; c <= cells; c += 1) {
      const cell = row.getCell(c);
      if (!layout.preserveHeaderFill) {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: design.palette.primary } };
      }
      cell.font = {
        name: "Aptos",
        size: 10,
        bold: true,
        color: { argb: design.palette.onPrimary },
      };
      cell.alignment = { vertical: "middle", wrapText: true };
      cell.border = { bottom: { style: "thin", color: { argb: design.palette.border } } };
    }
    if (layout.titleRow !== undefined) {
      if (!Number.isSafeInteger(layout.titleRow) || layout.titleRow < 1 || layout.titleRow >= layout.headerRow) {
        throw new Error("Invalid Factory title position");
      }
      const titleCell = ws.getRow(layout.titleRow).getCell(1);
      if (titleCell.value != null) {
        titleCell.font = {
          name: "Aptos Display",
          size: 16,
          bold: true,
          color: { argb: design.palette.primary },
        };
      }
    }
    // Preserve existing print areas, page setup, frozen views, row data and
    // all conditional/status fills. Only add a noninvasive print brand if
    // the original builder has not configured its own header.
    if (design.printLayout && design.showBranding && !ws.headerFooter.oddHeader) {
      ws.headerFooter.oddHeader = "&L" + (design.headerText || design.brandName).replaceAll("&", "");
      if (design.footerText && !ws.headerFooter.oddFooter) ws.headerFooter.oddFooter = "&L" + design.footerText;
    }
  }
}
