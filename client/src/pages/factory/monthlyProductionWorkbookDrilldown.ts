/** Self-contained worksheet navigation: Matrix → Workers → Daily Summary → Bale References. */
import type { ExcelJS } from "@/lib/excelHelper";
import type { MonthlyProductionExcelRow } from "./monthlyProductionExcelExport";

export type MonthlyProductionExportBale = {
  baleId: number;
  productId: number;
  month: string;
  workerId: number;
  workerName: string;
  referenceNumber: string;
  baleCode: string;
  date: string;
  productName: string;
  weightKg: string;
  status: string;
  category: string;
  grade: string;
  locationName: string;
};

type Period = string; // YYYY-MM or ALL (all exported months)
const ALL = "ALL";
const numberFormat = "#,##0";
const weightFormat = "#,##0.###";
const sectionBlue = "FF1E40AF";
const darkBlue = "FF182437";
const headerFill = "FFE2E8F0";
const lightBlue = "FFDBEAFE";
const lightRow = "FFF8FAFC";

export const matrixPeriodKey = (productId: number, period: string): string => productId + "|" + period;
const workerPeriodKey = (productId: number, workerId: number, period: Period) =>
  productId + "|" + workerId + "|" + period;
const referenceDateKey = (productId: number, workerId: number, date: string) =>
  productId + "|" + workerId + "|" + date;

const fill = (argb: string): ExcelJS.Fill =>
  ({ type: "pattern", pattern: "solid", fgColor: { argb } });

const tabLink = (sheet: string, row: number) => "#'" + sheet + "'!A" + row;

/** Numeric internal hyperlink: cached number ensures the report is readable without recalculation. */
export function numericSheetLink(sheet: string, row: number, quantity: number): ExcelJS.CellFormulaValue {
  if (!Number.isSafeInteger(row) || row <= 0) throw new Error("Missing worksheet drill-down target");
  return {
    formula: 'HYPERLINK("' + tabLink(sheet, row) + '",' + quantity + ")",
    result: quantity,
  };
}

function textSheetLink(sheet: string, row: number, label: string): ExcelJS.CellFormulaValue {
  return {
    formula: 'HYPERLINK("' + tabLink(sheet, row) + '","' + label.replaceAll('"', '""') + '")',
    result: label,
  };
}

function initializeSheet(sheet: ExcelJS.Worksheet, title: string, headings: string[], widths: number[]) {
  const last = sheet.getColumn(headings.length).letter;
  sheet.mergeCells("A1:" + last + "1");
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { name: "Aptos Display", size: 17, bold: true, color: { argb: "FFFFFFFF" } };
  sheet.getCell("A1").fill = fill(darkBlue);
  sheet.getCell("A1").alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(1).height = 38;
  sheet.mergeCells("A2:" + last + "2");
  sheet.getCell("A2").value = "This sheet is part of the exported production snapshot. Click underlined quantities to open the next worksheet.";
  sheet.getCell("A2").font = { name: "Aptos", size: 10, color: { argb: "FF475569" } };
  sheet.getCell("A2").alignment = { vertical: "middle", indent: 1 };
  sheet.getRow(2).height = 26;
  const header = sheet.addRow(headings);
  header.height = 27;
  header.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = fill(headerFill);
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: darkBlue } };
    cell.alignment = { vertical: "middle" };
  });
  widths.forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  sheet.views = [{ state: "frozen", ySplit: 3 }];
  sheet.pageSetup.orientation = "landscape";
  sheet.pageSetup.paperSize = 9;
  sheet.pageSetup.fitToPage = true;
  sheet.pageSetup.fitToWidth = 1;
  sheet.pageSetup.fitToHeight = 0;
  sheet.pageSetup.printTitlesRow = "1:3";
  sheet.pageSetup.margins = { left: 0.3, right: 0.3, top: 0.45, bottom: 0.45, header: 0.2, footer: 0.2 };
  sheet.headerFooter.oddFooter = "&LBusiness OS Factory&CPage &P of &N";
}

function section(sheet: ExcelJS.Worksheet, label: string, matrixRow: number): number {
  const row = sheet.addRow([label, "", "", "", "", textSheetLink("Monthly Production", matrixRow, "Back to matrix")]);
  sheet.mergeCells("A" + row.number + ":E" + row.number);
  row.height = 26;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = fill(sectionBlue);
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: "FFFFFFFF" } };
    cell.alignment = { vertical: "middle", indent: 1 };
  });
  return row.number;
}

function styleDataRow(sheet: ExcelJS.Worksheet, rowNumber: number) {
  const row = sheet.getRow(rowNumber);
  row.height = 20;
  if (rowNumber % 2) {
    row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill(lightRow); });
  }
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.alignment = { vertical: "middle" };
    cell.font = { name: "Aptos", size: 10, color: { argb: "FF0F172A" } };
  });
}

function styleLink(cell: ExcelJS.Cell) {
  cell.font = { name: "Aptos", size: 10, underline: true, bold: true, color: { argb: "FF1D4ED8" } };
}

function subtotal(sheet: ExcelJS.Worksheet, label: string, quantity: number, weight: number) {
  const row = sheet.addRow([label, quantity, weight, "", "", ""]);
  row.height = 23;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = fill(lightBlue);
    cell.font = { name: "Aptos", size: 10, bold: true, color: { argb: darkBlue } };
  });
  row.getCell(2).numFmt = numberFormat;
  row.getCell(3).numFmt = weightFormat;
  sheet.addRow([]);
}

function groupedByWorker(bales: MonthlyProductionExportBale[]) {
  const groups = new Map<number, MonthlyProductionExportBale[]>();
  for (const bale of bales) {
    const existing = groups.get(bale.workerId) ?? [];
    existing.push(bale);
    groups.set(bale.workerId, existing);
  }
  return [...groups.entries()].sort((a, b) =>
    b[1].length - a[1].length || a[1][0].workerName.localeCompare(b[1][0].workerName)
  );
}

function sumWeight(bales: MonthlyProductionExportBale[]): number {
  return bales.reduce((sum, bale) => sum + Number(bale.weightKg || 0), 0);
}

export function buildProductionDrilldownSheets(
  workbook: ExcelJS.Workbook,
  products: MonthlyProductionExcelRow[],
  months: string[],
  monthLabels: string[],
  bales: MonthlyProductionExportBale[]
): Map<string, number> {
  const workersSheet = workbook.addWorksheet("Worker Breakdown");
  const dailySheet = workbook.addWorksheet("Daily Summary");
  const referenceSheet = workbook.addWorksheet("Bale References");
  initializeSheet(workersSheet, "PRODUCTION BY WORKER", ["Worker", "Bales", "Weight (kg)", "Article", "Period", "Open daily list"], [33, 16, 18, 18, 25, 21]);
  initializeSheet(dailySheet, "DAILY BALE PRODUCTION", ["Date", "Product name", "Qty", "Weight (kg)", "Month", "Open references"], [18, 40, 14, 18, 18, 22]);
  initializeSheet(referenceSheet, "INDIVIDUAL BALE REFERENCES",
    ["Product", "Worker", "Month", "Date", "Reference number", "Bale code", "Qty", "Weight (kg)", "Status", "Category", "Grade", "Location"],
    [37, 30, 15, 17, 21, 18, 9, 16, 19, 22, 18, 26]);

  const productPositions = new Map(products.map((product, index) => [product.productId, index]));
  const sorted = [...bales].sort((a, b) =>
    (productPositions.get(a.productId) ?? 99999) - (productPositions.get(b.productId) ?? 99999) ||
    a.workerId - b.workerId ||
    b.date.localeCompare(a.date) ||
    a.referenceNumber.localeCompare(b.referenceNumber)
  );

  const baleReferenceAnchor = new Map<string, number>();
  for (const bale of sorted) {
    const key = referenceDateKey(bale.productId, bale.workerId, bale.date);
    if (!baleReferenceAnchor.has(key)) baleReferenceAnchor.set(key, referenceSheet.rowCount + 1);
    const row = referenceSheet.addRow([
      bale.productName, bale.workerName, bale.month, bale.date, bale.referenceNumber,
      bale.baleCode, 1, Number(bale.weightKg), bale.status, bale.category, bale.grade, bale.locationName,
    ]);
    // The detailed worksheet is intentionally lightly styled for large exports.
    row.getCell(7).numFmt = numberFormat;
    row.getCell(8).numFmt = weightFormat;
  }
  referenceSheet.autoFilter = { from: { row: 3, column: 1 },
    to: { row: Math.max(3, referenceSheet.rowCount), column: 12 } };

  const byProduct = new Map<number, MonthlyProductionExportBale[]>();
  for (const bale of sorted) {
    const existing = byProduct.get(bale.productId) ?? [];
    existing.push(bale);
    byProduct.set(bale.productId, existing);
  }

  // Daily sheets are created before worker summaries so the latter can link to
  // their exact section. ALL contains the same bales, summarized across months.
  const dailyAnchors = new Map<string, number>();
  for (const [productIndex, product] of products.entries()) {
    const productBales = byProduct.get(product.productId) ?? [];
    if (!productBales.length) continue;
    const periods = [...months.filter((month) => productBales.some((bale) => bale.month === month)), ALL];
    for (const period of periods) {
      const forPeriod = period === ALL ? productBales : productBales.filter((bale) => bale.month === period);
      const workerGroups = groupedByWorker(forPeriod);
      for (const [workerId, workerBales] of workerGroups) {
        const key = workerPeriodKey(product.productId, workerId, period);
        const anchor = section(dailySheet, product.name + " • " + workerBales[0].workerName +
          " • " + (period === ALL ? "All selected months" : monthLabels[months.indexOf(period)]),
        7 + productIndex);
        dailyAnchors.set(key, anchor);
        const daily = new Map<string, MonthlyProductionExportBale[]>();
        for (const bale of workerBales) {
          const items = daily.get(bale.date) ?? [];
          items.push(bale);
          daily.set(bale.date, items);
        }
        for (const [date, items] of [...daily.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
          const row = dailySheet.addRow([date, product.name, items.length, sumWeight(items), items[0].month, "View bales"]);
          styleDataRow(dailySheet, row.number);
          const refRow = baleReferenceAnchor.get(referenceDateKey(product.productId, workerId, date));
          if (refRow == null) throw new Error("Unable to locate bale details for " + date);
          row.getCell(3).value = numericSheetLink("Bale References", refRow, items.length);
          row.getCell(6).value = textSheetLink("Bale References", refRow, "View references");
          styleLink(row.getCell(3));
          styleLink(row.getCell(6));
          row.getCell(3).numFmt = numberFormat;
          row.getCell(4).numFmt = weightFormat;
        }
        subtotal(dailySheet, "TOTAL", workerBales.length, sumWeight(workerBales));
      }
    }
  }

  const matrixAnchors = new Map<string, number>();
  for (const [productIndex, product] of products.entries()) {
    const productBales = byProduct.get(product.productId) ?? [];
    if (!productBales.length) continue;
    const periods = [...months.filter((month) => productBales.some((bale) => bale.month === month)), ALL];
    for (const period of periods) {
      const forPeriod = period === ALL ? productBales : productBales.filter((bale) => bale.month === period);
      const matrixCol = period === ALL ? 4 + months.length : 4 + months.indexOf(period);
      const matrixCellRow = 7 + productIndex;
      const anchor = section(workersSheet, product.name + " • " +
        (period === ALL ? "All selected months" : monthLabels[months.indexOf(period)]), matrixCellRow);
      matrixAnchors.set(matrixPeriodKey(product.productId, period), anchor);
      for (const [workerId, workerBales] of groupedByWorker(forPeriod)) {
        const destination = dailyAnchors.get(workerPeriodKey(product.productId, workerId, period));
        if (destination == null) throw new Error("Missing worker daily summary");
        const row = workersSheet.addRow([
          workerBales[0].workerName, workerBales.length, sumWeight(workerBales),
          product.articleCode, period === ALL ? "All selected months" : monthLabels[months.indexOf(period)],
          "View daily production",
        ]);
        styleDataRow(workersSheet, row.number);
        row.getCell(2).value = numericSheetLink("Daily Summary", destination, workerBales.length);
        row.getCell(6).value = textSheetLink("Daily Summary", destination, "View daily production");
        styleLink(row.getCell(2));
        styleLink(row.getCell(6));
        row.getCell(2).numFmt = numberFormat;
        row.getCell(3).numFmt = weightFormat;
      }
      subtotal(workersSheet, "TOTAL", forPeriod.length, sumWeight(forPeriod));
      // Make the section's Back-to-Matrix jump to the selected count column.
      const back = workersSheet.getRow(anchor).getCell(6);
      back.value = { formula: 'HYPERLINK("#\\'Monthly Production\\'!' + columnLetter(matrixCol) +
        matrixCellRow + '","Back to matrix")', result: "Back to matrix" };
    }
  }

  // Keep page setup bounded for report consumers that print the extra sheets.
  for (const sheet of [workersSheet, dailySheet, referenceSheet]) {
    sheet.pageSetup.printArea = "A1:" + sheet.getColumn(sheet.columnCount).letter + Math.max(3, sheet.rowCount);
  }
  return matrixAnchors;
}

function columnLetter(col: number): string {
  let n = col;
  let letters = "";
  while (n > 0) {
    n--;
    letters = String.fromCharCode(65 + (n % 26)) + letters;
    n = Math.floor(n / 26);
  }
  return letters;
}
