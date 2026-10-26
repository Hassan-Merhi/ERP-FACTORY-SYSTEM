import type ExcelJS from "exceljs";
import type { MixBatchRow } from "./MixBatchList";

/**
 * Uses the persisted historical mix-batch weight and total cost (NOT today's
 * supplier rate). Carry-forward rows are excluded to avoid double counting.
 * Only records visible to the user's selected Factory company are exported.
 */
type CostRow = {
  date: string;
  month: string;
  code: string;
  name: string;
  kg: number;
  cost: number;
  status: string;
  flag: string;
};

type CostGroup = {
  key: string;
  count: number;
  kg: number;
  cost: number;
  zeroCost: number;
};

const NAVY = "FF17283F";
const NAVY_2 = "FF243C58";
const TEAL = "FF0C807C";
const GOLD = "FFF59E0B";
const PALE = "FFF3F7FA";
const TEXT = "FF25364B";
const WHITE = "FFFFFFFF";
const MUTED = "FF62758D";
const ALERT = "FFFFE8DA";
const KG_FMT = '#,##0.000;[Red](#,##0.000);"–"';
const USD_FMT = '$#,##0.00;[Red]($#,##0.00);"–"';
const RATE_FMT = '$0.0000;[Red]($0.0000);"–"';
const PCT_FMT = '+0.0%;[Red]-0.0%;"–"';

function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(batch: MixBatchRow): string {
  const value = batch.batchDate || batch.createdAt;
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "Unknown";
}

function excelDate(key: string): Date | string {
  return /^\d{4}-\d{2}-\d{2}$/.test(key)
    ? new Date(`${key}T12:00:00.000Z`)
    : key;
}

function textValue(value: string): string {
  const trimmed = value.replace(/[\u0000-\u001F]/g, " ").slice(0, 220);
  return /^[=+@\-]/.test(trimmed.trimStart()) ? `'${trimmed}` : trimmed;
}

export function compileRows(batches: MixBatchRow[]): CostRow[] {
  return batches
    .filter(batch => batch.carryForwardFromId == null)
    .map(batch => {
      const date = dateKey(batch);
      const kg = numeric(batch.totalWeightKg);
      const cost = numeric(batch.totalCost);
      return {
        date,
        month: date === "Unknown" ? "Unknown" : date.slice(0, 7),
        code: textValue(batch.batchCode || ""),
        name: textValue(batch.name || ""),
        kg,
        cost,
        status: textValue(batch.status || ""),
        flag: kg <= 0 ? "CHECK WEIGHT" : cost <= 0 ? "CHECK COST" : "",
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date) || b.code.localeCompare(a.code));
}

export function groupRows(rows: CostRow[], period: "date" | "month"): CostGroup[] {
  const map = new Map<string, CostGroup>();
  for (const row of rows) {
    const key = row[period];
    const group = map.get(key) || { key, count: 0, kg: 0, cost: 0, zeroCost: 0 };
    group.count += 1;
    group.kg += row.kg;
    group.cost += row.cost;
    if (row.flag) group.zeroCost += 1;
    map.set(key, group);
  }
  return Array.from(map.values()).sort((a, b) => b.key.localeCompare(a.key));
}

function color(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

function banner(sheet: ExcelJS.Worksheet, title: string, subtitle: string, endCol: string) {
  sheet.mergeCells(`A1:${endCol}2`);
  sheet.getCell("A1").value = title;
  sheet.getCell("A1").font = { name: "Aptos Display", size: 20, bold: true, color: { argb: WHITE } };
  sheet.getCell("A1").alignment = { vertical: "middle" };
  for (const row of [1, 2]) {
    sheet.getRow(row).height = 24;
    for (let c = 1; c <= sheet.getColumn(endCol).number; c++) sheet.getRow(row).getCell(c).fill = color(NAVY);
  }
  sheet.mergeCells(`A3:${endCol}3`);
  sheet.getCell("A3").value = subtitle;
  sheet.getCell("A3").font = { name: "Aptos", size: 10, color: { argb: MUTED }, italic: true };
  sheet.getRow(3).height = 25;
}

function header(sheet: ExcelJS.Worksheet, labels: string[]) {
  const row = sheet.getRow(4);
  row.values = labels;
  row.height = 29;
  row.eachCell({ includeEmpty: true }, cell => {
    cell.fill = color(NAVY_2);
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  sheet.views = [{ state: "frozen", ySplit: 4 }];
}

function styleData(sheet: ExcelJS.Worksheet, lastRow: number, colCount: number) {
  for (let r = 5; r <= lastRow; r++) {
    const row = sheet.getRow(r);
    row.height = 21;
    for (let c = 1; c <= colCount; c++) {
      const cell = row.getCell(c);
      cell.fill = color(r % 2 === 0 ? PALE : WHITE);
      cell.font = { name: "Aptos", size: 10, color: { argb: TEXT } };
      cell.alignment = { vertical: "middle", horizontal: c >= 3 ? "right" : "left" };
      cell.border = { bottom: { style: "hair", color: { argb: "FFE6EDF3" } } };
    }
  }
  if (lastRow >= 5) sheet.autoFilter = { from: "A4", to: `${sheet.getColumn(colCount).letter}${lastRow}` };
  sheet.pageSetup = { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
}

function dashboardCard(
  sheet: ExcelJS.Worksheet,
  labelRange: string,
  valueRange: string,
  label: string,
  value: ExcelJS.CellValue,
  format: string,
) {
  sheet.mergeCells(labelRange);
  sheet.mergeCells(valueRange);
  const labelCell = sheet.getCell(labelRange.split(":")[0]);
  const valueCell = sheet.getCell(valueRange.split(":")[0]);
  labelCell.value = label;
  labelCell.fill = color(NAVY_2);
  labelCell.font = { name: "Aptos", size: 10, bold: true, color: { argb: WHITE } };
  labelCell.alignment = { horizontal: "center", vertical: "middle" };
  valueCell.value = value;
  valueCell.fill = color(PALE);
  valueCell.font = { name: "Aptos Display", size: 21, bold: true, color: { argb: TEAL } };
  valueCell.numFmt = format;
  valueCell.alignment = { horizontal: "center", vertical: "middle" };
}

export async function exportMixBatchCostAnalysis(
  batches: MixBatchRow[],
  requestedMonth: string,
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
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth)
    ? requestedMonth : new Date().toISOString().slice(0, 7);
  const current = months.find(item => item.key === month);
  const previousYear = Number(month.slice(0, 4));
  const previousMonthNum = Number(month.slice(5, 7)) - 1;
  const previousKey = previousMonthNum === 0
    ? `${previousYear - 1}-12`
    : `${previousYear}-${String(previousMonthNum).padStart(2, "0")}`;
  const previous = months.find(item => item.key === previousKey);
  const selectedDays = days.filter(item => item.key.startsWith(month));
  const selectedMonthlyRow = months.findIndex(item => item.key === month) + 5;
  const monthlyLinkedValue = (column: string, fallback: number): ExcelJS.CellValue =>
    selectedMonthlyRow >= 5
      ? { formula: `'Monthly Average'!${column}${selectedMonthlyRow}`, result: fallback }
      : fallback;
  const weightedAverage = current && current.kg > 0 ? current.cost / current.kg : 0;
  const previousAverage = previous && previous.kg > 0 ? previous.cost / previous.kg : 0;

  const dashboard = workbook.addWorksheet("Dashboard", { properties: { tabColor: { argb: TEAL } } });
  const daily = workbook.addWorksheet("Daily Average", { properties: { tabColor: { argb: GOLD } } });
  const monthly = workbook.addWorksheet("Monthly Average", { properties: { tabColor: { argb: TEAL } } });
  const detail = workbook.addWorksheet("Mix Batch Details", { properties: { tabColor: { argb: NAVY } } });

  // Details are the auditable source for all downstream Excel calculations.
  banner(detail, "MIX BATCH DETAILS", "Saved historical valuation · original batches only · all dates · USD", "I");
  header(detail, ["Production date", "Month", "Batch code", "Mix name / origins", "Mixed KG", "Recorded cost (USD)", "Cost per KG", "Status", "Review"]);
  [19, 14, 23, 39, 19, 23, 17, 17, 20].forEach((width, index) => { detail.getColumn(index + 1).width = width; });
  rows.forEach(item => {
    const row = detail.addRow([
      excelDate(item.date), item.month, item.code, item.name, item.kg, item.cost,
      null, item.status, item.flag,
    ]);
    row.getCell(7).value = { formula: `IFERROR(F${row.number}/E${row.number},0)`, result: item.kg > 0 ? item.cost / item.kg : 0 };
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

  banner(daily, "DAILY WEIGHTED AVERAGE", "Daily cost = total recorded mix cost ÷ total KG mixed · all historical days", "G");
  header(daily, ["Production date", "Month", "Batches", "Total KG mixed", "Total cost USD", "Avg cost / KG", "Cost review flags"]);
  [20, 16, 14, 21, 23, 22, 21].forEach((width, index) => { daily.getColumn(index + 1).width = width; });
  days.forEach(item => {
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

  banner(monthly, "MONTHLY COST COMPARISON", "Compare every month's true kilogram-weighted mix cost · original batches only", "G");
  header(monthly, ["Month", "Batches", "Total KG mixed", "Total cost USD", "Avg cost / KG", "Change vs prior month", "Cost review flags"]);
  [20, 15, 23, 24, 21, 25, 22].forEach((width, index) => { monthly.getColumn(index + 1).width = width; });
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
      const delta = item.kg > 0 ? (item.cost / item.kg) / (prior.cost / prior.kg) - 1 : 0;
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

  banner(dashboard, "RAW MATERIALS  |  COST INTELLIGENCE", `Report month: ${month}    •    Created ${new Date().toLocaleDateString("en-GB")}    •    Recorded USD valuations`, "H");
  for (let c = 1; c <= 8; c++) dashboard.getColumn(c).width = 17;
  dashboard.getRow(5).height = 25;
  dashboard.getRow(6).height = 24;
  dashboard.getRow(7).height = 24;
  dashboardCard(dashboard, "A5:B5", "A6:B7", "WEIGHTED AVG / KG", monthlyLinkedValue("E", weightedAverage), RATE_FMT);
  dashboardCard(dashboard, "C5:D5", "C6:D7", "TOTAL KG MIXED", monthlyLinkedValue("C", current?.kg || 0), KG_FMT);
  dashboardCard(dashboard, "E5:F5", "E6:F7", "TOTAL RECORDED COST", monthlyLinkedValue("D", current?.cost || 0), USD_FMT);
  dashboardCard(dashboard, "G5:H5", "G6:H7", "MIX BATCHES", monthlyLinkedValue("B", current?.count || 0), "#,##0");
  dashboard.mergeCells("A9:H9");
  dashboard.getCell("A9").value = `DAILY COST BREAKDOWN  ·  ${month}`;
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
      excelDate(item.key), item.count, item.kg, item.cost,
      item.kg > 0 ? item.cost / item.kg : 0, item.zeroCost || 0,
      index === 0 ? previousAverage : null,
      index === 0 && previousAverage > 0 ? weightedAverage / previousAverage - 1 : null,
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

  // Highlight unusually high/low weighted rates without hiding any figures.
  if (daily.rowCount >= 6) {
    daily.addConditionalFormatting({
      ref: `F5:F${daily.rowCount}`,
      rules: [{ type: "colorScale", cfvo: [{ type: "min" }, { type: "max" }], color: [{ argb: "FFD7F3EF" }, { argb: "FFFFE0C0" }] }],
    });
  }
  if (monthly.rowCount >= 6) {
    monthly.addConditionalFormatting({
      ref: `E5:E${monthly.rowCount}`,
      rules: [{ type: "colorScale", cfvo: [{ type: "min" }, { type: "max" }], color: [{ argb: "FFD7F3EF" }, { argb: "FFFFE0C0" }] }],
    });
  }
  await writeFile(workbook, `Raw_Materials_Cost_Analysis_${month}.xlsx`);
}
