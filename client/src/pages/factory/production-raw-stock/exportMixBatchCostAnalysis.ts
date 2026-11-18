// Extracted from ./mixBatchCostExport.ts to keep that module under the source-size cap.
import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import type ExcelJS from "exceljs";
import type { MixBatchRow } from "./MixBatchList";
import {
  ALERT,
  GOLD,
  KG_FMT,
  MUTED,
  NAVY,
  NAVY_2,
  PALE,
  PCT_FMT,
  RATE_FMT,
  TEAL,
  TEXT,
  USD_FMT,
  WHITE,
  banner,
  color,
  compileRows,
  dashboardCard,
  excelDate,
  groupDailySupplierCosts,
  groupRows,
  header,
  numeric,
  styleData,
  textValue,
  type MixBatchCostSourceRow,
} from "./mixBatchCostExportGroupDailySupplierCosts";

export async function exportMixBatchCostAnalysis(
  batches: MixBatchRow[],
  requestedMonth: string,
  sources: MixBatchCostSourceRow[] = []
): Promise<void> {
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
  for (const day of days) {
    for (const source of dailySuppliers.filter((item) => item.date === day.key)) {
      const row = bySupplier.addRow([
        excelDate(day.key),
        source.supplierName,
        source.categoryName,
        source.batches,
        source.kg,
        source.cost,
        null,
        source.containers,
        source.review,
      ]);
      row.getCell(7).value = {
        formula: `IFERROR(F${row.number}/E${row.number},0)`,
        result: source.kg > 0 ? source.cost / source.kg : 0,
      };
      row.getCell(1).numFmt = "dd mmm yyyy";
      row.getCell(5).numFmt = KG_FMT;
      row.getCell(6).numFmt = USD_FMT;
      row.getCell(7).numFmt = RATE_FMT;
    }
    const total = bySupplier.addRow([
      excelDate(day.key),
      "DAILY TOTAL",
      "",
      day.count,
      day.kg,
      day.cost,
      null,
      "",
      day.zeroCost ? `${day.zeroCost} batch review(s)` : "",
    ]);
    total.getCell(7).value = {
      formula: `IFERROR(F${total.number}/E${total.number},0)`,
      result: day.kg > 0 ? day.cost / day.kg : 0,
    };
    total.getCell(1).numFmt = "dd mmm yyyy";
    total.getCell(5).numFmt = KG_FMT;
    total.getCell(6).numFmt = USD_FMT;
    total.getCell(7).numFmt = RATE_FMT;
  }
  styleData(bySupplier, bySupplier.rowCount, 9);
  for (let r = 5; r <= bySupplier.rowCount; r++) {
    for (const c of [2, 3, 8, 9]) bySupplier.getRow(r).getCell(c).alignment = { horizontal: "left" };
    if (bySupplier.getCell(`B${r}`).value === "DAILY TOTAL") {
      for (let c = 1; c <= 9; c++) {
        const cell = bySupplier.getRow(r).getCell(c);
        cell.fill = color(NAVY_2);
        cell.font = { name: "Aptos", bold: true, color: { argb: WHITE } };
      }
    } else if (bySupplier.getCell(`I${r}`).value) {
      bySupplier.getCell(`I${r}`).fill = color(ALERT);
      bySupplier.getCell(`I${r}`).font = { name: "Aptos", bold: true, color: { argb: "FF9A3412" } };
    }
  }

  banner(
    daily,
    "DAILY WEIGHTED AVERAGE",
    "Daily cost = total recorded mix cost ÷ total KG mixed · all historical days",
    "G"
  );
  header(daily, [
    "Production date",
    "Month",
    "Batches",
    "Total KG mixed",
    "Total cost USD",
    "Avg cost / KG",
    "Cost review flags",
  ]);
  [20, 16, 14, 21, 23, 22, 21].forEach((width, index) => {
    daily.getColumn(index + 1).width = width;
  });
  days.forEach((item) => {
    const row = daily.addRow([excelDate(item.key), item.key.slice(0, 7), null, null, null, null, null]);
    const n = row.number;
    row.getCell(3).value = { formula: `COUNTIF(${sourceDate},A${n})`, result: item.count };
    row.getCell(4).value = { formula: `SUMIF(${sourceDate},A${n},${sourceKg})`, result: item.kg };
    row.getCell(5).value = { formula: `SUMIF(${sourceDate},A${n},${sourceCost})`, result: item.cost };
    row.getCell(6).value = { formula: `IFERROR(E${n}/D${n},0)`, result: item.kg > 0 ? item.cost / item.kg : 0 };
    row.getCell(7).value = { formula: `COUNTIFS(${sourceDate},A${n},${sourceReview},"?*")`, result: item.zeroCost };
    row.getCell(1).numFmt = "dd mmm yyyy";
    row.getCell(4).numFmt = KG_FMT;
    row.getCell(5).numFmt = USD_FMT;
    row.getCell(6).numFmt = RATE_FMT;
  });
  styleData(daily, daily.rowCount, 7);

  banner(
    monthly,
    "MONTHLY COST COMPARISON",
    "Compare every month's true kilogram-weighted mix cost · original batches only",
    "G"
  );
  header(monthly, [
    "Month",
    "Batches",
    "Total KG mixed",
    "Total cost USD",
    "Avg cost / KG",
    "Change vs prior month",
    "Cost review flags",
  ]);
  [20, 15, 23, 24, 21, 25, 22].forEach((width, index) => {
    monthly.getColumn(index + 1).width = width;
  });
  months.forEach((item, index) => {
    const row = monthly.addRow([item.key, null, null, null, null, null, null]);
    const n = row.number;
    row.getCell(2).value = { formula: `COUNTIF(${sourceMonth},A${n})`, result: item.count };
    row.getCell(3).value = { formula: `SUMIF(${sourceMonth},A${n},${sourceKg})`, result: item.kg };
    row.getCell(4).value = { formula: `SUMIF(${sourceMonth},A${n},${sourceCost})`, result: item.cost };
    row.getCell(5).value = { formula: `IFERROR(D${n}/C${n},0)`, result: item.kg > 0 ? item.cost / item.kg : 0 };
    // Latest month is first, so the prior calendar month is the next row when present.
    const prior = months[index + 1];
    const priorDate = /^\d{4}-\d{2}$/.test(item.key) ? new Date(`${item.key}-01T12:00:00Z`) : null;
    if (priorDate) priorDate.setUTCMonth(priorDate.getUTCMonth() - 1);
    if (priorDate && prior && prior.key === priorDate.toISOString().slice(0, 7) && prior.kg > 0 && prior.cost > 0) {
      const delta = item.kg > 0 ? item.cost / item.kg / (prior.cost / prior.kg) - 1 : 0;
      row.getCell(6).value = { formula: `IFERROR(E${n}/E${n + 1}-1,0)`, result: Number.isFinite(delta) ? delta : 0 };
    } else {
      row.getCell(6).value = "—";
    }
    row.getCell(7).value = { formula: `COUNTIFS(${sourceMonth},A${n},${sourceReview},"?*")`, result: item.zeroCost };
    row.getCell(3).numFmt = KG_FMT;
    row.getCell(4).numFmt = USD_FMT;
    row.getCell(5).numFmt = RATE_FMT;
    row.getCell(6).numFmt = PCT_FMT;
  });
  styleData(monthly, monthly.rowCount, 7);

  banner(
    dashboard,
    "RAW MATERIALS  |  COST INTELLIGENCE",
    `Report period: ${allTime ? "ALL TIME" : month}    •    Created ${new Date().toLocaleDateString("en-GB")}    •    Recorded USD valuations`,
    "H"
  );
  for (let c = 1; c <= 8; c++) dashboard.getColumn(c).width = 17;
  dashboard.getRow(5).height = 25;
  dashboard.getRow(6).height = 24;
  dashboard.getRow(7).height = 24;
  dashboardCard(
    dashboard,
    "A5:B5",
    "A6:B7",
    "WEIGHTED AVG / KG",
    allTime ? { formula: "IFERROR(E6/C6,0)", result: weightedAverage } : monthlyLinkedValue("E", weightedAverage),
    RATE_FMT
  );
  dashboardCard(dashboard, "C5:D5", "C6:D7", "TOTAL KG MIXED", monthlyLinkedValue("C", current?.kg || 0), KG_FMT);
  dashboardCard(
    dashboard,
    "E5:F5",
    "E6:F7",
    "TOTAL RECORDED COST",
    monthlyLinkedValue("D", current?.cost || 0),
    USD_FMT
  );
  dashboardCard(dashboard, "G5:H5", "G6:H7", "MIX BATCHES", monthlyLinkedValue("B", current?.count || 0), "#,##0");
  dashboard.mergeCells("A9:H9");
  dashboard.getCell("A9").value = `DAILY COST BREAKDOWN  ·  ${allTime ? "ALL TIME" : month}`;
  dashboard.getCell("A9").font = { bold: true, size: 12, color: { argb: WHITE } };
  dashboard.getCell("A9").fill = color(TEAL);
  dashboard.getRow(9).height = 27;
  const dashHeaders = ["Day", "Batches", "KG mixed", "Cost USD", "Avg $/KG", "Review", "Prior month avg", "Change"];
  dashHeaders.forEach((label, i) => {
    const cell = dashboard.getRow(11).getCell(i + 1);
    cell.value = label;
    cell.fill = color(NAVY_2);
    cell.font = { name: "Aptos", bold: true, color: { argb: WHITE }, size: 10 };
    cell.alignment = { wrapText: true };
  });
  dashboard.getRow(11).height = 29;
  selectedDays.forEach((item, index) => {
    const r = 12 + index;
    dashboard.getRow(r).values = [
      excelDate(item.key),
      item.count,
      item.kg,
      item.cost,
      item.kg > 0 ? item.cost / item.kg : 0,
      item.zeroCost || 0,
      !allTime && index === 0 ? previousAverage : null,
      !allTime && index === 0 && previousAverage > 0 ? weightedAverage / previousAverage - 1 : null,
    ];
    dashboard.getRow(r).height = 22;
    dashboard.getCell(`A${r}`).numFmt = "dd mmm";
    dashboard.getCell(`C${r}`).numFmt = KG_FMT;
    dashboard.getCell(`D${r}`).numFmt = USD_FMT;
    dashboard.getCell(`E${r}`).numFmt = RATE_FMT;
    dashboard.getCell(`G${r}`).numFmt = RATE_FMT;
    dashboard.getCell(`H${r}`).numFmt = PCT_FMT;
    for (let c = 1; c <= 8; c++) {
      const cell = dashboard.getRow(r).getCell(c);
      cell.fill = color(r % 2 ? PALE : WHITE);
      cell.font = { name: "Aptos", color: { argb: TEXT }, size: 10 };
    }
    if (item.zeroCost) dashboard.getCell(`F${r}`).fill = color(ALERT);
  });
  if (!selectedDays.length) {
    dashboard.mergeCells("A12:H12");
    dashboard.getCell("A12").value = "No production mix batches recorded for this month.";
    dashboard.getCell("A12").font = { italic: true, color: { argb: MUTED } };
  }
  const footerRow = Math.max(14, 13 + selectedDays.length);
  dashboard.mergeCells(`A${footerRow}:H${footerRow}`);
  dashboard.getCell(`A${footerRow}`).value =
    "METHOD  •  Cost per KG = Σ stored batch total cost ÷ Σ original batch KG. Zero-cost/zero-weight rows are flagged. No historical values are repriced.";
  dashboard.getCell(`A${footerRow}`).font = { size: 9, italic: true, color: { argb: MUTED } };
  dashboard.getCell(`A${footerRow}`).alignment = { wrapText: true };
  dashboard.getRow(footerRow).height = 36;
  dashboard.views = [{ state: "frozen", ySplit: 11 }];

  // High/low amounts remain visible with readable fixed USD and KG formats.
  styleFactoryOperationalWorkbook(workbook, [
    { name: "Daily Supplier Costs", headerRow: 4, titleRow: 1 },
    { name: "Daily Totals", headerRow: 4, titleRow: 1 },
    { name: "Monthly Average", headerRow: 4, titleRow: 1 },
    { name: "Source Details", headerRow: 4, titleRow: 1 },
    { name: "Mix Batch Details", headerRow: 4, titleRow: 1 },
  ]);
  await writeFile(workbook, `Raw_Materials_Cost_Analysis_${allTime ? "All_Time" : month}.xlsx`);
}
