import { styleSpecializedWorkbook } from "@shared/universal-excel/specializedWorkbookStyle";
import type { UniversalExcelAppearance } from "@shared/universal-excel/design";
import { optionalSpecializedExcelAppearance } from "@/lib/excelAppearanceClient";
/**
 * Print-ready Monthly Production Matrix export.
 * CSV is kept separately as a data-only format; colors and page orientation
 * require the XLSX format. This module is loaded only when Excel is requested.
 */
import { ExcelJS, writeFile } from "@/lib/excelHelper";
import {
  buildProductionDrilldownSheets,
  matrixPeriodKey,
  numericSheetLink,
  type MonthlyProductionExportBale,
} from "./monthlyProductionWorkbookDrilldown";

export type MonthlyProductionExcelRow = {
  productId: number;
  name: string;
  articleCode: string;
  categoryName: string;
  values: number[];
};

export type MonthlyProductionExcelOptions = {
  rows: MonthlyProductionExcelRow[];
  months: string[];
  monthLabels: string[];
  category: string;
  search: string;
  bales: MonthlyProductionExportBale[];
  appearance?: UniversalExcelAppearance;
};

const PALETTE = {
  navy: "FF182437",
  blue: "FF1E40AF",
  title: "FF0F172A",
  subdued: "FF475569",
  border: "FFE2E8F0",
  white: "FFFFFFFF",
  stripe: "FFF1F5F9",
  emeraldFill: "FFD1FAE5",
  emeraldText: "FF065F46",
  redFill: "FFFEE2E2",
  redText: "FF991B1B",
  totalFill: "FFDBEAFE",
  totalText: "FF1E3A8A",
};

/** Convert a 1-based worksheet column index to its Excel A1-style letters. */
function columnLetter(column: number): string {
  if (!Number.isSafeInteger(column) || column < 1) {
    throw new RangeError("Excel column index must be a positive integer.");
  }
  let remaining = column;
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(65 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

const background = (color: string): ExcelJS.Fill => ({
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: color },
});

/** Same highest/lowest logic as the on-screen Monthly Production Matrix. */
export function productionMonthTone(values: number[], index: number): "highest" | "lowest" | "normal" {
  if (values.length <= 1) return "normal";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return "normal";
  if (values[index] === max) return "highest";
  if (values[index] === min) return "lowest";
  return "normal";
}

export function buildMonthlyProductionExcelWorkbook(options: MonthlyProductionExcelOptions): ExcelJS.Workbook {
  const { rows, months, monthLabels, category, search, bales } = options;
  if (months.length === 0 || months.length !== monthLabels.length) {
    throw new Error("Select at least one valid month before exporting.");
  }
  if (rows.some((row) => row.values.length !== months.length)) {
    throw new Error("Production matrix export contains mismatched month columns.");
  }
  // The exported file must be self-contained: no external ERP links or network requests after download.
  const validProducts = new Set(rows.map((row) => row.productId));
  const validMonths = new Set(months);
  const actualCounts = new Map<string, number>();
  const seenBales = new Set<string>();
  for (const bale of bales) {
    if (!validProducts.has(bale.productId) || !validMonths.has(bale.month)) {
      throw new Error("Production details fall outside the selected matrix filters.");
    }
    const baleKey = bale.productId + "|" + bale.baleId;
    if (seenBales.has(baleKey)) throw new Error("Duplicate bale found in production export.");
    seenBales.add(baleKey);
    const key = matrixPeriodKey(bale.productId, bale.month);
    actualCounts.set(key, (actualCounts.get(key) ?? 0) + 1);
  }
  for (const row of rows) {
    for (let i = 0; i < months.length; i += 1) {
      if (row.values[i] !== (actualCounts.get(matrixPeriodKey(row.productId, months[i])) ?? 0)) {
        throw new Error("Production counts changed during export. Please export again.");
      }
    }
  }

  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Business OS Factory";
  workbook.created = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;
  const worksheet = workbook.addWorksheet("Monthly Production", {
    properties: { defaultRowHeight: 19 },
  });

  const totalColumn = 4 + months.length;
  const lastColumn = columnLetter(totalColumn);
  const headerRowNumber = 6;
  const firstDataRow = headerRowNumber + 1;
  const lastDataRow = headerRowNumber + rows.length;
  const totalRowNumber = lastDataRow + 1;
  const monthStartColumn = 4;

  worksheet.mergeCells("A1:" + lastColumn + "1");
  const titleCell = worksheet.getCell("A1");
  titleCell.value = "MONTHLY PRODUCTION MATRIX";
  titleCell.font = { name: "Aptos Display", size: 19, bold: true, color: { argb: PALETTE.white } };
  titleCell.fill = background(PALETTE.navy);
  titleCell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  worksheet.getRow(1).height = 39;

  worksheet.mergeCells("A2:" + lastColumn + "2");
  const subtitleCell = worksheet.getCell("A2");
  subtitleCell.value =
    "Produced bales by item and month  |  " +
    rows.length.toLocaleString() +
    " items  |  " +
    months.length +
    " months" +
    (category ? "  |  Category: " + category : "") +
    (search.trim() ? "  |  Search: " + search.trim() : "");
  subtitleCell.font = { name: "Aptos", size: 10, color: { argb: PALETTE.subdued } };
  subtitleCell.alignment = { vertical: "middle", indent: 1 };
  worksheet.getRow(2).height = 25;

  worksheet.mergeCells("A3:" + lastColumn + "3");
  const legendCell = worksheet.getCell("A3");
  legendCell.value =
    "GREEN = highest month     |     RED = lowest month     |     CLICK COUNTS = explore worksheets inside this Excel file";
  legendCell.font = { name: "Aptos", size: 9, italic: true, color: { argb: PALETTE.subdued } };
  legendCell.alignment = { vertical: "middle", indent: 1 };
  worksheet.getRow(3).height = 22;

  worksheet.mergeCells("A4:" + lastColumn + "4");
  worksheet.getRow(4).height = 12;
  worksheet.mergeCells("A5:" + lastColumn + "5");
  worksheet.getCell("A5").value =
    "Offline interactive workbook: Matrix → Worker Breakdown → Daily Summary → Bale References. No ERP browser or connection needed.";
  worksheet.getCell("A5").font = { name: "Aptos", size: 9, color: { argb: PALETTE.subdued } };
  worksheet.getCell("A5").alignment = { vertical: "middle", indent: 1 };
  worksheet.getRow(5).height = 23;

  const headings = ["Item Name", "Article Code", "Category", ...monthLabels, "Total Bales"];
  const tableData = rows.map((row) => [
    row.name,
    row.articleCode,
    row.categoryName,
    ...row.values,
    row.values.reduce((sum, count) => sum + count, 0),
  ]);
  // A real Excel table offers column filters, striped rows and native table navigation.
  worksheet.addTable({
    name: "FactoryMonthlyProduction",
    ref: "A" + headerRowNumber,
    headerRow: true,
    totalsRow: false,
    style: { theme: "TableStyleMedium2", showRowStripes: true },
    columns: headings.map((name) => ({ name, filterButton: true })),
    rows: tableData,
  });

  const headerRow = worksheet.getRow(headerRowNumber);
  headerRow.height = 31;
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.fill = background(PALETTE.blue);
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: PALETTE.white } };
    cell.alignment = { horizontal: col < monthStartColumn ? "left" : "right", vertical: "middle", indent: 1 };
  });

  for (let i = 0; i < rows.length; i += 1) {
    const dataRow = worksheet.getRow(firstDataRow + i);
    dataRow.height = 21;
    const base = i % 2 === 0 ? PALETTE.white : PALETTE.stripe;
    dataRow.eachCell({ includeEmpty: true }, (cell, col) => {
      cell.font = { name: "Aptos", size: 10, color: { argb: PALETTE.title } };
      cell.fill = background(base);
      cell.border = { bottom: { style: "hair", color: { argb: PALETTE.border } } };
      cell.alignment = { vertical: "middle", horizontal: col >= monthStartColumn ? "right" : "left", indent: 1 };
      if (col >= monthStartColumn) cell.numFmt = "#,##0";
    });
    for (let monthIndex = 0; monthIndex < months.length; monthIndex += 1) {
      const cell = dataRow.getCell(monthStartColumn + monthIndex);
      const tone = productionMonthTone(rows[i].values, monthIndex);
      if (tone === "highest") {
        cell.fill = background(PALETTE.emeraldFill);
        cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: PALETTE.emeraldText } };
      } else if (tone === "lowest") {
        cell.fill = background(PALETTE.redFill);
        cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: PALETTE.redText } };
      }
    }
    const totalCell = dataRow.getCell(totalColumn);
    totalCell.fill = background(PALETTE.totalFill);
    totalCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: PALETTE.totalText } };
    const itemTotal = rows[i].values.reduce((sum, count) => sum + count, 0);
    totalCell.value = itemTotal;
  }

  const totalRow = worksheet.getRow(totalRowNumber);
  totalRow.height = 30;
  worksheet.mergeCells("A" + totalRowNumber + ":C" + totalRowNumber);
  totalRow.getCell(1).value = "TOTAL PRODUCED (BALES)";
  const monthTotals = months.map((_, monthIndex) => rows.reduce((sum, row) => sum + row.values[monthIndex], 0));
  const grandTotal = monthTotals.reduce((sum, count) => sum + count, 0);
  monthTotals.concat(grandTotal).forEach((sum, index) => {
    const col = monthStartColumn + index;
    const cell = totalRow.getCell(col);
    // HYPERLINK may recalculate as text in Excel. Use the validated snapshot
    // total directly rather than SUM over hyperlink formulas.
    cell.value = sum;
    cell.numFmt = "#,##0";
  });
  totalRow.eachCell({ includeEmpty: true }, (cell, col) => {
    cell.fill = background(PALETTE.navy);
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: PALETTE.white } };
    cell.alignment = { vertical: "middle", horizontal: col >= monthStartColumn ? "right" : "left", indent: 1 };
    cell.border = { top: { style: "medium", color: { argb: PALETTE.blue } } };
  });

  worksheet.getColumn(1).width = 37;
  worksheet.getColumn(2).width = 17;
  worksheet.getColumn(3).width = 20;
  for (let col = monthStartColumn; col <= totalColumn; col += 1) {
    worksheet.getColumn(col).width = col === totalColumn ? 17 : 15;
  }
  worksheet.views = [{ state: "frozen", xSplit: 3, ySplit: headerRowNumber }];
  worksheet.pageSetup.orientation = "landscape";
  worksheet.pageSetup.paperSize = 9; // A4
  worksheet.pageSetup.fitToPage = true;
  worksheet.pageSetup.fitToWidth = 1;
  worksheet.pageSetup.fitToHeight = 0; // allow additional pages vertically
  worksheet.pageSetup.horizontalCentered = true;
  worksheet.pageSetup.printArea = "A1:" + lastColumn + totalRowNumber;
  worksheet.pageSetup.printTitlesRow = "1:" + headerRowNumber;
  worksheet.pageSetup.margins = {
    left: 0.25,
    right: 0.25,
    top: 0.4,
    bottom: 0.45,
    header: 0.2,
    footer: 0.2,
  };
  worksheet.headerFooter.oddFooter = "&LBusiness OS Factory&CPage &P of &N&RPrinted &D";

  // Build the other three worksheets first to resolve exact internal anchor rows.
  const anchors = buildProductionDrilldownSheets(workbook, rows, months, monthLabels, bales);
  for (const [index, product] of rows.entries()) {
    const matrixRow = worksheet.getRow(firstDataRow + index);
    for (const [monthIndex, month] of months.entries()) {
      const count = product.values[monthIndex];
      if (count <= 0) continue;
      const anchor = anchors.get(matrixPeriodKey(product.productId, month));
      if (anchor == null) throw new Error("Monthly worker breakdown is missing.");
      const cell = matrixRow.getCell(monthStartColumn + monthIndex);
      cell.value = numericSheetLink("Worker Breakdown", anchor, count);
      cell.font = { ...cell.font, underline: true };
    }
    const itemTotal = product.values.reduce((sum, count) => sum + count, 0);
    if (itemTotal > 0) {
      const anchor = anchors.get(matrixPeriodKey(product.productId, "ALL"));
      if (anchor == null) throw new Error("Item worker breakdown is missing.");
      const cell = matrixRow.getCell(totalColumn);
      cell.value = numericSheetLink("Worker Breakdown", anchor, itemTotal);
      cell.font = { ...cell.font, underline: true };
    }
  }
  styleSpecializedWorkbook(workbook, {
    appearance: options.appearance,
    expectedSheetNames: ["Monthly Production", "Worker Breakdown", "Daily Summary", "Bale References"],
    sheets: [
      { name: "Monthly Production", purpose: "report", headerRow: 6 },
      { name: "Worker Breakdown", purpose: "report", headerRow: 3 },
      { name: "Daily Summary", purpose: "report", headerRow: 3 },
      { name: "Bale References", purpose: "report", headerRow: 3 },
    ],
  });
  return workbook;
}

export async function exportMonthlyProductionExcel(options: MonthlyProductionExcelOptions): Promise<void> {
  const appearance = await optionalSpecializedExcelAppearance();
  const workbook = buildMonthlyProductionExcelWorkbook({ ...options, appearance });
  const fileName = "factory-monthly-production-" + new Date().toISOString().slice(0, 10) + ".xlsx";
  await writeFile(workbook, fileName);
}
