// Extracted from ./mixBatchCostExport.ts to keep that module under the source-size cap.
import type ExcelJS from "exceljs";
import type { MixBatchRow } from "./MixBatchList";

/**
 * Uses the persisted historical mix-batch weight and total cost (NOT today's
 * supplier rate). Carry-forward rows are excluded to avoid double counting.
 * Only records visible to the user's selected Factory company are exported.
 */
type CostRow = {
  id: number;
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

export const NAVY = "FF17283F";

export const NAVY_2 = "FF243C58";

export const TEAL = "FF0C807C";

export const GOLD = "FFF59E0B";

export const PALE = "FFF3F7FA";

export const TEXT = "FF25364B";

export const WHITE = "FFFFFFFF";

export const MUTED = "FF62758D";

export const ALERT = "FFFFE8DA";

export const KG_FMT = '#,##0.000;[Red](#,##0.000);"–"';

export const USD_FMT = '$#,##0.00;[Red]($#,##0.00);"–"';

export const RATE_FMT = '$0.0000;[Red]($0.0000);"–"';

export const PCT_FMT = '+0.0%;[Red]-0.0%;"–"';

export function numeric(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateKey(batch: MixBatchRow): string {
  const value = batch.batchDate || batch.createdAt;
  const date = typeof value === "string" ? value.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "Unknown";
}

export function excelDate(key: string): Date | string {
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? new Date(`${key}T12:00:00.000Z`) : key;
}

export function textValue(value: string): string {
  const trimmed = Array.from(value, (character) => (character.charCodeAt(0) < 32 ? " " : character))
    .join("")
    .slice(0, 220);
  return /^[=+@-]/.test(trimmed.trimStart()) ? `'${trimmed}` : trimmed;
}

export function compileRows(batches: MixBatchRow[]): CostRow[] {
  return batches
    .filter((batch) => batch.carryForwardFromId == null)
    .map((batch) => {
      const date = dateKey(batch);
      const kg = numeric(batch.totalWeightKg);
      const cost = numeric(batch.totalCost);
      return {
        id: batch.id,
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

export interface MixBatchCostSourceRow {
  id: number;
  mixBatchId: number;
  supplierId: number | null;
  supplierName: string;
  categoryName: string | null;
  containerNumber: string | null;
  sourceBatchId: number | null;
  weightKg: string | number;
  totalCost: string | number;
  costPerKg: string | number;
}

export interface DailySupplierCostRow {
  date: string;
  supplierName: string;
  categoryName: string;
  batches: number;
  kg: number;
  cost: number;
  containers: string;
  review: string;
}

export function groupDailySupplierCosts(
  batches: MixBatchRow[],
  sources: MixBatchCostSourceRow[]
): DailySupplierCostRow[] {
  const originals = compileRows(batches);
  const batchById = new Map(originals.map((b) => [b.id, b]));
  const map = new Map<string, DailySupplierCostRow & { ids: Set<number>; boxes: Set<string> }>();
  for (const source of sources) {
    const batch = batchById.get(Number(source.mixBatchId));
    if (!batch) continue;
    const supplierName = textValue(source.supplierName || "Unassigned supplier");
    const categoryName = textValue(source.categoryName || "Uncategorized");
    const key = JSON.stringify([batch.date, source.supplierId ?? supplierName]);
    let value = map.get(key);
    if (!value) {
      value = {
        date: batch.date,
        supplierName,
        categoryName,
        batches: 0,
        kg: 0,
        cost: 0,
        containers: "",
        review: "",
        ids: new Set(),
        boxes: new Set(),
      };
      map.set(key, value);
    }
    value.kg += numeric(source.weightKg);
    value.cost += numeric(source.totalCost);
    value.ids.add(batch.id);
    if (source.containerNumber) value.boxes.add(textValue(source.containerNumber));
    if (value.categoryName !== categoryName) value.categoryName = "Multiple categories";
    if (numeric(source.weightKg) <= 0 || numeric(source.totalCost) <= 0) value.review = "CHECK SOURCE COST";
    if (!source.supplierId && !source.sourceBatchId) value.review = "CHECK SUPPLIER";
  }
  const result: DailySupplierCostRow[] = [...map.values()].map((row) => ({
    date: row.date,
    supplierName: row.supplierName,
    categoryName: row.categoryName,
    batches: row.ids.size,
    kg: row.kg,
    cost: row.cost,
    containers: [...row.boxes].join(", "),
    review: row.review,
  }));
  // Preserve original-batch totals and visibly flag any source attribution gaps.
  for (const day of groupRows(originals, "date")) {
    const attributed = result.filter((r) => r.date === day.key);
    const differenceKg = day.kg - attributed.reduce((sum, r) => sum + r.kg, 0);
    const differenceCost = day.cost - attributed.reduce((sum, r) => sum + r.cost, 0);
    if (Math.abs(differenceKg) > 0.005 || Math.abs(differenceCost) > 0.01)
      result.push({
        date: day.key,
        supplierName: "Unattributed / reconciliation",
        categoryName: "Batch valuation",
        batches: day.count,
        kg: differenceKg,
        cost: differenceCost,
        containers: "",
        review: "REVIEW SOURCE VS BATCH",
      });
  }
  return result.sort((a, b) => b.date.localeCompare(a.date) || a.supplierName.localeCompare(b.supplierName));
}

export function color(argb: string): ExcelJS.Fill {
  return { type: "pattern", pattern: "solid", fgColor: { argb } };
}

export function banner(sheet: ExcelJS.Worksheet, title: string, subtitle: string, endCol: string) {
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

export function header(sheet: ExcelJS.Worksheet, labels: string[]) {
  const row = sheet.getRow(4);
  row.values = labels;
  row.height = 29;
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = color(NAVY_2);
    cell.font = { name: "Aptos", bold: true, size: 10, color: { argb: WHITE } };
    cell.alignment = { vertical: "middle", wrapText: true };
  });
  sheet.views = [{ state: "frozen", ySplit: 4 }];
}

export function styleData(sheet: ExcelJS.Worksheet, lastRow: number, colCount: number) {
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

export function dashboardCard(
  sheet: ExcelJS.Worksheet,
  labelRange: string,
  valueRange: string,
  label: string,
  value: ExcelJS.CellValue,
  format: string
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
