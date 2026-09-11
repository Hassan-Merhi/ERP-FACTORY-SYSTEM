/**
 * Shared state and helpers for the factoryBaleExportRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryBaleExportRoutes.ts.
 */
import { db } from "../../../db";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryRawMaterialAdjustments,
  factorySupplierCategories,
} from "@shared/schema";
import { eq, and, sql, isNull, not } from "drizzle-orm";

// ── Weekly report: shared Excel builder (used by download + WhatsApp send) ───

export type WrCatKey = number | "uncategorized";
export function _wrIsoWeekKey(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1) - day;
  const mon = new Date(d);
  mon.setUTCDate(d.getUTCDate() + diff);
  const y = mon.getUTCFullYear();
  const jan4 = new Date(Date.UTC(y, 0, 4));
  const week = Math.ceil(((mon.getTime() - jan4.getTime()) / 86400000 + jan4.getUTCDay() + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}
export function _wrMondayOfWeek(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00");
  const day = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() + ((day === 0 ? -6 : 1) - day));
  return d.toISOString().slice(0, 10);
}
export const _WR_DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
export function _wrDayName(dateStr: string): string {
  return _WR_DAY_NAMES[(new Date(dateStr + "T00:00:00").getUTCDay() + 6) % 7];
}
export function _wrFmtDate(dateStr: string): string {
  const [, mm, dd] = dateStr.split("-");
  return `${dd}/${mm}`;
}

export async function buildWeeklyReportExcelBuffer(companyId: number, period: string = "all"): Promise<Buffer> {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let periodStart: string | null = null;
  if (period === "week") periodStart = _wrMondayOfWeek(todayStr);
  else if (period === "month")
    periodStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  else if (period === "year") periodStart = `${today.getUTCFullYear()}-01-01`;

  const rawStockRows = await db
    .select({
      containerId: factoryRawStock.containerId,
      categoryId: factorySuppliers.supplierCategoryId,
      receivedKg: factoryRawStock.receivedKg,
      usedKg: factoryRawStock.usedKg,
      offloadedAt: factoryRawStock.offloadedAt,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
    .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
    .where(and(eq(factoryRawStock.companyId, companyId), sql`${factoryContainers.status} != 'DELETED'`));

  const catRows = await db
    .select({ id: factorySupplierCategories.id, name: factorySupplierCategories.name })
    .from(factorySupplierCategories)
    .where(eq(factorySupplierCategories.companyId, companyId));
  const catNameMap = new Map<number, string>(catRows.map((c) => [c.id, c.name]));
  const catBalMap = new Map<WrCatKey, { name: string; currentBalance: number }>();
  const getCK = (id: number | null | undefined): WrCatKey => (id != null ? id : "uncategorized") as WrCatKey;
  const getCN = (id: number | null | undefined): string =>
    id != null ? catNameMap.get(id) || `Category ${id}` : "Uncategorized";

  const stockInByDate = new Map<string, Map<WrCatKey, number>>();
  for (const r of rawStockRows) {
    const ck = getCK(r.categoryId as number | null);
    const rem = (parseFloat(r.receivedKg as string) || 0) - (parseFloat(r.usedKg as string) || 0);
    if (catBalMap.has(ck)) catBalMap.get(ck)!.currentBalance += rem;
    else catBalMap.set(ck, { name: getCN(r.categoryId as number | null), currentBalance: rem });
    const ds = (r.offloadedAt as Date).toISOString().slice(0, 10);
    if (!stockInByDate.has(ds)) stockInByDate.set(ds, new Map());
    stockInByDate.get(ds)!.set(ck, (stockInByDate.get(ds)!.get(ck) || 0) + (parseFloat(r.receivedKg as string) || 0));
  }

  const adjRows = await db
    .select({
      date: factoryRawMaterialAdjustments.date,
      type: factoryRawMaterialAdjustments.type,
      kg: factoryRawMaterialAdjustments.kg,
      catId: factorySuppliers.supplierCategoryId,
    })
    .from(factoryRawMaterialAdjustments)
    .leftJoin(factorySuppliers, eq(factoryRawMaterialAdjustments.supplierId, factorySuppliers.id))
    .where(eq(factoryRawMaterialAdjustments.companyId, companyId));
  const manualRemoveByDate = new Map<string, Map<WrCatKey, number>>();
  for (const adj of adjRows) {
    const ck = getCK(adj.catId as number | null);
    const kg = parseFloat(adj.kg as string) || 0;
    if (kg <= 0) continue;
    const isAdd = adj.type === "ADD";
    if (catBalMap.has(ck)) catBalMap.get(ck)!.currentBalance += isAdd ? kg : -kg;
    else catBalMap.set(ck, { name: getCN(adj.catId as number | null), currentBalance: isAdd ? kg : -kg });
    const ds = typeof adj.date === "string" ? adj.date.slice(0, 10) : (adj.date as any).toISOString().slice(0, 10);
    if (isAdd) {
      if (!stockInByDate.has(ds)) stockInByDate.set(ds, new Map());
      stockInByDate.get(ds)!.set(ck, (stockInByDate.get(ds)!.get(ck) || 0) + kg);
    } else {
      if (!manualRemoveByDate.has(ds)) manualRemoveByDate.set(ds, new Map());
      manualRemoveByDate.get(ds)!.set(ck, (manualRemoveByDate.get(ds)!.get(ck) || 0) + kg);
    }
  }

  const srcRows = await db
    .select({
      containerId: factoryMixBatchSources.containerId,
      batchDate: factoryMixBatches.batchDate,
      batchCreatedAt: factoryMixBatches.createdAt,
      catId: factorySuppliers.supplierCategoryId,
      weightKg: factoryMixBatchSources.weightKg,
    })
    .from(factoryMixBatchSources)
    .innerJoin(factoryMixBatches, eq(factoryMixBatchSources.mixBatchId, factoryMixBatches.id))
    .innerJoin(factoryContainers, eq(factoryMixBatchSources.containerId, factoryContainers.id))
    .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
    .where(
      and(
        eq(factoryMixBatches.companyId, companyId),
        not(isNull(factoryMixBatchSources.containerId)),
        sql`${factoryContainers.status} != 'DELETED'`
      )
    );
  const srcSumByCont = new Map<number, number>();
  for (const r of srcRows)
    srcSumByCont.set(
      r.containerId as number,
      (srcSumByCont.get(r.containerId as number) || 0) + (parseFloat(r.weightKg as string) || 0)
    );

  const consByDate = new Map<string, Map<WrCatKey, number>>();
  for (const r of srcRows) {
    const w = parseFloat(r.weightKg as string) || 0;
    if (w <= 0) continue;
    const ds = r.batchDate
      ? typeof r.batchDate === "string"
        ? r.batchDate
        : (r.batchDate as Date).toISOString().slice(0, 10)
      : (r.batchCreatedAt as Date).toISOString().slice(0, 10);
    const ck = getCK(r.catId as number | null);
    if (!consByDate.has(ds)) consByDate.set(ds, new Map());
    consByDate.get(ds)!.set(ck, (consByDate.get(ds)!.get(ck) || 0) + w);
    if (!catBalMap.has(ck)) catBalMap.set(ck, { name: getCN(r.catId as number | null), currentBalance: 0 });
  }
  for (const r of rawStockRows) {
    const actualUsed = parseFloat(r.usedKg as string) || 0;
    if (actualUsed <= 0) continue;
    const gap = actualUsed - (srcSumByCont.get(r.containerId as number) || 0);
    if (gap <= 0.001) continue;
    const ds = (r.offloadedAt as Date).toISOString().slice(0, 10);
    const ck = getCK(r.categoryId as number | null);
    if (!consByDate.has(ds)) consByDate.set(ds, new Map());
    consByDate.get(ds)!.set(ck, (consByDate.get(ds)!.get(ck) || 0) + gap);
    if (!catBalMap.has(ck)) catBalMap.set(ck, { name: getCN(r.categoryId as number | null), currentBalance: 0 });
  }
  for (const [ds, cm] of manualRemoveByDate) {
    if (!consByDate.has(ds)) consByDate.set(ds, new Map());
    for (const [ck, kg] of cm) consByDate.get(ds)!.set(ck, (consByDate.get(ds)!.get(ck) || 0) + kg);
  }

  const allDates = new Set<string>([...consByDate.keys(), ...stockInByDate.keys()]);
  const weekMap = new Map<string, string[]>();
  for (const d of allDates) {
    const wk = _wrIsoWeekKey(d);
    if (!weekMap.has(wk)) weekMap.set(wk, []);
    weekMap.get(wk)!.push(d);
  }
  const sortedWks = [...weekMap.keys()].sort();
  for (const wk of sortedWks) weekMap.get(wk)!.sort();
  const allCKs = [...catBalMap.keys()];
  const weekCons = new Map<string, Map<WrCatKey, number>>();
  const weekSI = new Map<string, Map<WrCatKey, number>>();
  for (const wk of sortedWks) {
    const cm = new Map<WrCatKey, number>();
    const sm = new Map<WrCatKey, number>();
    for (const d of weekMap.get(wk)!) {
      for (const [ck, kg] of consByDate.get(d) || new Map()) cm.set(ck, (cm.get(ck) || 0) + kg);
      for (const [ck, kg] of stockInByDate.get(d) || new Map()) sm.set(ck, (sm.get(ck) || 0) + kg);
    }
    weekCons.set(wk, cm);
    weekSI.set(wk, sm);
  }
  const totSI = new Map<WrCatKey, number>();
  const totC = new Map<WrCatKey, number>();
  for (const wk of sortedWks) {
    for (const [ck, v] of weekSI.get(wk)!) totSI.set(ck, (totSI.get(ck) || 0) + v);
    for (const [ck, v] of weekCons.get(wk)!) totC.set(ck, (totC.get(ck) || 0) + v);
  }
  const openBals = new Map<string, Map<WrCatKey, number>>();
  const firstOpen = new Map<WrCatKey, number>(
    allCKs.map((ck) => [ck, (catBalMap.get(ck)?.currentBalance || 0) - (totSI.get(ck) || 0) + (totC.get(ck) || 0)])
  );
  if (sortedWks.length > 0) openBals.set(sortedWks[0], firstOpen);
  for (let i = 0; i < sortedWks.length; i++) {
    const wk = sortedWks[i];
    const op = openBals.get(wk)!;
    const cl = new Map<WrCatKey, number>();
    for (const ck of allCKs)
      cl.set(ck, (op.get(ck) || 0) + (weekSI.get(wk)!.get(ck) || 0) - (weekCons.get(wk)!.get(ck) || 0));
    if (i < sortedWks.length - 1) openBals.set(sortedWks[i + 1], cl);
  }
  const displayWks = periodStart
    ? sortedWks.filter((wk) => {
        const dates = weekMap.get(wk)!;
        return dates[dates.length - 1] >= periodStart! || _wrMondayOfWeek(dates[0]) >= periodStart!;
      })
    : sortedWks;

  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const sh = wb.addWorksheet("Weekly Report");
  const BLUE = "FF1E40AF",
    LB = "FFE0EAFF",
    DG = "FF374151",
    TBG = "FFD1FAE5";
  const BS: import("exceljs").Border = { style: "thin", color: { argb: "FFD1D5DB" } };
  const BA = { top: BS, left: BS, bottom: BS, right: BS };
  sh.getColumn(1).width = 24;
  sh.getColumn(2).width = 14;
  sh.getColumn(3).width = 12;
  let row = 1;
  if (displayWks.length === 0) {
    const r = sh.getRow(row);
    const c = r.getCell(1);
    c.value = "No production data found";
    c.font = { italic: true, size: 11 };
    sh.mergeCells(row, 1, row, 12);
    row++;
  }
  for (const wk of displayWks) {
    const dates = weekMap.get(wk)!;
    const monDate = _wrMondayOfWeek(dates[0]);
    const monD = new Date(monDate + "T00:00:00");
    const days: string[] = [];
    for (let di = 0; di < 7; di++) {
      const d = new Date(monD);
      d.setUTCDate(monD.getUTCDate() + di);
      days.push(d.toISOString().slice(0, 10));
    }
    const tCols = 3 + days.length + 2;
    const tRow = sh.getRow(row);
    tRow.getCell(1).value = `Week of ${_wrFmtDate(monDate)} – ${_wrFmtDate(days[6])}  |  ${wk}`;
    tRow.getCell(1).font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
    tRow.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
    tRow.getCell(1).alignment = { horizontal: "center", vertical: "middle" };
    sh.mergeCells(row, 1, row, tCols);
    tRow.height = 22;
    row++;
    const hdrs = [
      "CATEGORY",
      "Balance",
      "Stock In",
      ...days.map((d) => `${_wrDayName(d)}\n${_wrFmtDate(d)}`),
      "TOTAL",
      "REMAINS",
    ];
    const hRow = sh.getRow(row);
    hdrs.forEach((h, ci) => {
      const c = hRow.getCell(ci + 1);
      c.value = h;
      c.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DG } };
      c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
      c.border = BA;
    });
    for (let di = 0; di < days.length; di++) sh.getColumn(4 + di).width = 10;
    sh.getColumn(4 + days.length).width = 11;
    sh.getColumn(5 + days.length).width = 12;
    hRow.height = 28;
    row++;
    const op = openBals.get(wk)!;
    const sm = weekSI.get(wk)!;
    const activeCKs = allCKs
      .filter((ck) => (weekCons.get(wk)!.get(ck) || 0) > 0.001 || (sm.get(ck) || 0) > 0.001)
      .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));
    let wtB = 0,
      wtSI = 0,
      wtT = 0,
      wtR = 0;
    const wtD = days.map(() => 0);
    for (const ck of activeCKs) {
      const info = catBalMap.get(ck)!;
      const ob = op.get(ck) || 0;
      const si = sm.get(ck) || 0;
      const dv = days.map((d) => consByDate.get(d)?.get(ck) || 0);
      const tot = weekCons.get(wk)!.get(ck) || 0;
      const rem = ob + si - tot;
      wtB += ob;
      wtSI += si;
      wtT += tot;
      wtR += rem;
      dv.forEach((v, i) => {
        wtD[i] += v;
      });
      const dr = sh.getRow(row);
      const vals: (string | number | null)[] = [
        info.name,
        Math.round(ob) || 0,
        si > 0.5 ? Math.round(si) : null,
        ...dv.map((v) => (v > 0.5 ? Math.round(v) : null)),
        Math.round(tot) > 0 ? Math.round(tot) : null,
        Math.round(rem),
      ];
      vals.forEach((v, ci) => {
        const c = dr.getCell(ci + 1);
        c.value = v;
        c.font = { size: 9 };
        c.border = BA;
        if (ci === 0) {
          c.font = { size: 9, bold: true };
          c.alignment = { vertical: "middle" };
        } else {
          c.alignment = { horizontal: "right", vertical: "middle" };
          c.numFmt = "#,##0";
        }
        if (ci >= 3 && ci < 3 + days.length && typeof v === "number")
          c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LB } };
      });
      dr.height = 16;
      row++;
    }
    const totRow = sh.getRow(row);
    const totVals: (string | number | null)[] = [
      "TOTAL",
      Math.round(wtB),
      wtSI > 0.5 ? Math.round(wtSI) : null,
      ...wtD.map((v) => (Math.round(v) > 0 ? Math.round(v) : null)),
      Math.round(wtT) > 0 ? Math.round(wtT) : null,
      Math.round(wtR),
    ];
    totVals.forEach((v, ci) => {
      const c = totRow.getCell(ci + 1);
      c.value = v;
      c.font = { bold: true, size: 9 };
      c.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TBG } };
      c.border = BA;
      if (ci === 0) c.alignment = { vertical: "middle" };
      else {
        c.alignment = { horizontal: "right", vertical: "middle" };
        c.numFmt = "#,##0";
      }
    });
    totRow.height = 18;
    row++;
    row++;
  }
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}
