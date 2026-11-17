import { styleFactoryOperationalWorkbook } from "@shared/universal-excel/factoryOperationalStyle";
import type { MixBatchRow } from "./MixBatchList";
import { exportFileName } from "@/lib/exportFile";
import {
  ALERT,
  KG_FMT,
  MUTED,
  NAVY_2,
  PALE,
  RATE_FMT,
  TEAL,
  TEXT,
  USD_FMT,
  WHITE,
  banner,
  color,
  dashboardCard,
  excelDate,
  header,
  styleData,
  type MixBatchCostSourceRow,
} from "./mixBatchCostExportGroupDailySupplierCosts";
import { exportMixBatchCostAnalysisStep1 } from "./exportMixBatchCostAnalysisStep1";
export { compileRows, groupDailySupplierCosts, groupRows } from "./mixBatchCostExportGroupDailySupplierCosts";
export type { DailySupplierCostRow, MixBatchCostSourceRow } from "./mixBatchCostExportGroupDailySupplierCosts";
const PCT_FMT = '+0.0%;[Red]-0.0%;"–"';

export async function exportMixBatchCostAnalysis(
  batches: MixBatchRow[],
  requestedMonth: string,
  sources: MixBatchCostSourceRow[] = []
): Promise<void> {
  const {
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
  } = await exportMixBatchCostAnalysisStep1(batches, requestedMonth, sources);
  exportMixBatchCostAnalysisStep2({
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
  });
  await exportMixBatchCostAnalysisStep3({ allTime, dashboard, month, selectedDays, workbook, writeFile });
}

function exportMixBatchCostAnalysisStep2({
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
}: Pick<
  Awaited<ReturnType<typeof exportMixBatchCostAnalysisStep1>>,
  | "allTime"
  | "bySupplier"
  | "current"
  | "daily"
  | "dailySuppliers"
  | "dashboard"
  | "days"
  | "month"
  | "monthly"
  | "monthlyLinkedValue"
  | "months"
  | "previousAverage"
  | "selectedDays"
  | "sourceCost"
  | "sourceDate"
  | "sourceKg"
  | "sourceMonth"
  | "sourceReview"
  | "weightedAverage"
>) {
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
  return {};
}

async function exportMixBatchCostAnalysisStep3({
  allTime,
  dashboard,
  month,
  selectedDays,
  workbook,
  writeFile,
}: Pick<
  Awaited<ReturnType<typeof exportMixBatchCostAnalysisStep1>>,
  "allTime" | "dashboard" | "month" | "selectedDays" | "workbook" | "writeFile"
>) {
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
  ]);
  await writeFile(workbook, exportFileName(`raw materials cost analysis ${allTime ? "all time" : month}`, "xlsx"));
  return {};
}
