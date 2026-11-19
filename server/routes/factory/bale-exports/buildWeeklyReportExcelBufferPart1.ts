// Extracted from ./_helpers.ts
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
import { plusMoney, toMoney } from "../../../lib/money";

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

/**
 * Normalizes an adjustment date column to a `YYYY-MM-DD` string.
 *
 * The column is a `varchar` today, so the value is normally already a string;
 * the `Date` branch is kept because callers may hand over a driver-parsed date
 * and `String(date)` would not produce an ISO date.
 */
export function _wrDateOnly(value: string | Date): string {
  return (typeof value === "string" ? value : value.toISOString()).slice(0, 10);
}

export async function buildWeeklyReportExcelBufferPart1(companyId: number, period: string) {
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
    const rem = toMoney(r.receivedKg as string)
      .minus(toMoney(r.usedKg as string))
      .toNumber();
    if (catBalMap.has(ck)) catBalMap.get(ck)!.currentBalance += rem;
    else catBalMap.set(ck, { name: getCN(r.categoryId as number | null), currentBalance: rem });
    const ds = (r.offloadedAt as Date).toISOString().slice(0, 10);
    if (!stockInByDate.has(ds)) stockInByDate.set(ds, new Map());
    stockInByDate.get(ds)!.set(ck, plusMoney(stockInByDate.get(ds)!.get(ck) || 0, r.receivedKg as string));
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
    const kg = toMoney(adj.kg as string).toNumber();
    if (kg <= 0) continue;
    const isAdd = adj.type === "ADD";
    if (catBalMap.has(ck)) catBalMap.get(ck)!.currentBalance += isAdd ? kg : -kg;
    else catBalMap.set(ck, { name: getCN(adj.catId as number | null), currentBalance: isAdd ? kg : -kg });
    const ds = _wrDateOnly(adj.date);
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
      plusMoney(srcSumByCont.get(r.containerId as number) || 0, r.weightKg as string)
    );

  const consByDate = new Map<string, Map<WrCatKey, number>>();
  for (const r of srcRows) {
    const w = toMoney(r.weightKg as string).toNumber();
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
    const actualUsed = toMoney(r.usedKg as string).toNumber();
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
  return { periodStart, catBalMap, consByDate, weekMap, sortedWks, allCKs, weekCons, weekSI, totSI, totC };
}
