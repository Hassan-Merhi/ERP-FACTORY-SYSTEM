// Extracted from ./mixBatchCostExport.ts to keep that module under the source-size cap.
import type ExcelJS from "exceljs";
import type { MixBatchRow } from "./MixBatchList";
import {
  ALERT,
  GOLD,
  KG_FMT,
  NAVY,
  RATE_FMT,
  TEAL,
  USD_FMT,
  banner,
  color,
  compileRows,
  excelDate,
  groupDailySupplierCosts,
  groupRows,
  header,
  numeric,
  styleData,
  textValue,
  type MixBatchCostSourceRow,
} from "./mixBatchCostExportGroupDailySupplierCosts";

export async function exportMixBatchCostAnalysisStep1(
  batches: MixBatchRow[],
  requestedMonth: string,
  sources: MixBatchCostSourceRow[]
) {
  // Deferred heavy dependency: don't load ExcelJS on ordinary Raw Materials visits.
  const { ExcelJS, writeFile } = await import("@/lib/excelHelper");
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Dakzo Systems - Factory";
  workbook.title = "Raw Materials - Historical Mix Cost Analysis";
  workbook.calcProperties.fullCalcOnLoad = true;

  const rows = compileRows(batches);
  const months = groupRows(rows, "month");
  const days = groupRows(rows, "date");
  const allTime = requestedMonth === "all-time";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : new Date().toISOString().slice(0, 7);
  const current = allTime
    ? {
        key: "all-time",
        count: rows.length,
        kg: rows.reduce((sum, r) => sum + r.kg, 0),
        cost: rows.reduce((sum, r) => sum + r.cost, 0),
        zeroCost: rows.filter((r) => !!r.flag).length,
      }
    : months.find((item) => item.key === month);
  const previousYear = Number(month.slice(0, 4));
  const previousMonthNum = Number(month.slice(5, 7)) - 1;
  const previousKey =
    previousMonthNum === 0 ? `${previousYear - 1}-12` : `${previousYear}-${String(previousMonthNum).padStart(2, "0")}`;
  const previous = months.find((item) => item.key === previousKey);
  const selectedDays = allTime ? days : days.filter((item) => item.key.startsWith(month));
  const dailySuppliers = groupDailySupplierCosts(batches, sources);
  const selectedMonthlyRow = months.findIndex((item) => item.key === month) + 5;
  const monthlyLinkedValue = (column: string, fallback: number): ExcelJS.CellValue =>
    allTime
      ? { formula: `SUM('Monthly Average'!${column}5:${column}${Math.max(5, months.length + 4)})`, result: fallback }
      : selectedMonthlyRow >= 5
        ? { formula: `'Monthly Average'!${column}${selectedMonthlyRow}`, result: fallback }
        : fallback;
  const weightedAverage = current && current.kg > 0 ? current.cost / current.kg : 0;
  const previousAverage = previous && previous.kg > 0 ? previous.cost / previous.kg : 0;

  const dashboard = workbook.addWorksheet("Dashboard", { properties: { tabColor: { argb: TEAL } } });
  const bySupplier = workbook.addWorksheet("Daily Supplier Costs", { properties: { tabColor: { argb: GOLD } } });
  const daily = workbook.addWorksheet("Daily Totals", { properties: { tabColor: { argb: GOLD } } });
  const monthly = workbook.addWorksheet("Monthly Average", { properties: { tabColor: { argb: TEAL } } });
  const sourceDetails = workbook.addWorksheet("Source Details", { properties: { tabColor: { argb: "FF64748B" } } });
  const detail = workbook.addWorksheet("Mix Batch Details", { properties: { tabColor: { argb: NAVY } } });

  // Details are the auditable source for all downstream Excel calculations.
  banner(detail, "MIX BATCH DETAILS", "Saved historical valuation · original batches only · all dates · USD", "I");
  header(detail, [
    "Production date",
    "Month",
    "Batch code",
    "Mix name / origins",
    "Mixed KG",
    "Recorded cost (USD)",
    "Cost per KG",
    "Status",
    "Review",
  ]);
  [19, 14, 23, 39, 19, 23, 17, 17, 20].forEach((width, index) => {
    detail.getColumn(index + 1).width = width;
  });
  rows.forEach((item) => {
    const row = detail.addRow([
      excelDate(item.date),
      item.month,
      item.code,
      item.name,
      item.kg,
      item.cost,
      null,
      item.status,
      item.flag,
    ]);
    row.getCell(7).value = {
      formula: `IFERROR(F${row.number}/E${row.number},0)`,
      result: item.kg > 0 ? item.cost / item.kg : 0,
    };
    row.getCell(1).numFmt = "dd mmm yyyy";
    row.getCell(5).numFmt = KG_FMT;
    row.getCell(6).numFmt = USD_FMT;
    row.getCell(7).numFmt = RATE_FMT;
  });
  styleData(detail, detail.rowCount, 9);
  for (let r = 5; r <= detail.rowCount; r++) {
    detail.getCell(`C${r}`).alignment = { horizontal: "left" };
    detail.getCell(`D${r}`).alignment = { horizontal: "left" };
    detail.getCell(`H${r}`).alignment = { horizontal: "left" };
    if (detail.getCell(`I${r}`).value) {
      detail.getCell(`I${r}`).fill = color(ALERT);
      detail.getCell(`I${r}`).font = { bold: true, color: { argb: "FF9A3412" } };
    }
  }

  const sourceEnd = Math.max(5, detail.rowCount);
  const sourceDate = `'Mix Batch Details'!$A$5:$A$${sourceEnd}`;
  const sourceMonth = `'Mix Batch Details'!$B$5:$B$${sourceEnd}`;
  const sourceKg = `'Mix Batch Details'!$E$5:$E$${sourceEnd}`;
  const sourceCost = `'Mix Batch Details'!$F$5:$F$${sourceEnd}`;
  const sourceReview = `'Mix Batch Details'!$I$5:$I$${sourceEnd}`;

  const batchById = new Map(rows.map((row) => [row.id, row]));
  const validSources = sources.filter((source) => batchById.has(Number(source.mixBatchId)));
  banner(
    sourceDetails,
    "MIX BATCH SOURCE DETAILS",
    "Every supplier / container contribution · historical recorded USD values · original batches only",
    "J"
  );
  header(sourceDetails, [
    "Date",
    "Batch",
    "Supplier / source",
    "Category",
    "Container",
    "KG",
    "Recorded $/KG",
    "Cost USD",
    "Source batch ID",
    "Review",
  ]);
  [18, 24, 37, 26, 22, 19, 20, 23, 19, 25].forEach((width, i) => {
    sourceDetails.getColumn(i + 1).width = width;
  });
  for (const source of validSources) {
    const batch = batchById.get(Number(source.mixBatchId))!;
    const kg = numeric(source.weightKg);
    const cost = numeric(source.totalCost);
    const row = sourceDetails.addRow([
      excelDate(batch.date),
      batch.code,
      textValue(source.supplierName || "Unassigned supplier"),
      textValue(source.categoryName || "Uncategorized"),
      textValue(source.containerNumber || ""),
      kg,
      null,
      cost,
      source.sourceBatchId ?? "",
      kg <= 0 || cost <= 0 ? "CHECK SOURCE COST" : !source.supplierId && !source.sourceBatchId ? "CHECK SUPPLIER" : "",
    ]);
    row.getCell(7).value = { formula: `IFERROR(H${row.number}/F${row.number},0)`, result: kg > 0 ? cost / kg : 0 };
    row.getCell(1).numFmt = "dd mmm yyyy";
    row.getCell(6).numFmt = KG_FMT;
    row.getCell(7).numFmt = RATE_FMT;
    row.getCell(8).numFmt = USD_FMT;
  }
  styleData(sourceDetails, sourceDetails.rowCount, 10);
  for (let r = 5; r <= sourceDetails.rowCount; r++) {
    for (const c of [2, 3, 4, 5, 10]) sourceDetails.getRow(r).getCell(c).alignment = { horizontal: "left" };
    if (sourceDetails.getCell(`J${r}`).value) sourceDetails.getCell(`J${r}`).fill = color(ALERT);
  }

  banner(
    bySupplier,
    "DAILY COST BY SUPPLIER",
    "Separate historical weighted-average cost for each supplier each day, with a bold combined daily total",
    "I"
  );
  header(bySupplier, [
    "Date",
    "Supplier / source",
    "Category",
    "Batches",
    "KG used",
    "Cost USD",
    "Avg USD / KG",
    "Containers",
    "Review",
  ]);
  [19, 38, 26, 15, 21, 24, 21, 32, 30].forEach((width, i) => {
    bySupplier.getColumn(i + 1).width = width;
  });
  return {
    allTime,
    bySupplier,
    current,
    daily,
    dailySuppliers,
    dashboard,
    days,
    month,
    monthly,
    monthlyLinkedValue,
    months,
    previousAverage,
    selectedDays,
    sourceCost,
    sourceDate,
    sourceKg,
    sourceMonth,
    sourceReview,
    weightedAverage,
    workbook,
    writeFile,
  };
}
