// Extracted from ./weekly-report.ts: a stage of weekly-report.
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
import { _wrDateOnly } from "./_helpers";
import { plusMoney, toMoney } from "../../../lib/money";
import type { Request, Response } from "express";

export type CatKey = number | "uncategorized";

export async function weeklyReportStep({ req, res }: { req: Request; res: Response }) {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  const format = (req.query.format as string) || "excel";
  const period = (req.query.period as string) || "all"; // "all" | "year" | "month" | "week"

  // Helper: ISO week key "YYYY-Www"
  function isoWeekKey(dateStr: string): string {
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
  function mondayOfWeek(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    d.setUTCDate(d.getUTCDate() + diff);
    return d.toISOString().slice(0, 10);
  }
  const DAY_NAMES = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  function dayName(dateStr: string): string {
    const d = new Date(dateStr + "T00:00:00");
    return DAY_NAMES[(d.getUTCDay() + 6) % 7];
  }
  function fmtDate(dateStr: string): string {
    const [, mm, dd] = dateStr.split("-");
    return `${dd}/${mm}`;
  }

  // Compute period filter boundary (inclusive start date, or null = no filter)
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  let periodStart: string | null = null;
  if (period === "week") {
    periodStart = mondayOfWeek(todayStr);
  } else if (period === "month") {
    periodStart = `${today.getUTCFullYear()}-${String(today.getUTCMonth() + 1).padStart(2, "0")}-01`;
  } else if (period === "year") {
    periodStart = `${today.getUTCFullYear()}-01-01`;
  }

  // 1. Fetch raw stock with supplier → category join (include containerId for scaling later)
  const rawStockRows = await db
    .select({
      containerId: factoryRawStock.containerId,
      supplierId: factoryContainers.supplierId,
      categoryId: factorySuppliers.supplierCategoryId,
      receivedKg: factoryRawStock.receivedKg,
      usedKg: factoryRawStock.usedKg,
      offloadedAt: factoryRawStock.offloadedAt,
    })
    .from(factoryRawStock)
    .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
    .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
    .where(and(eq(factoryRawStock.companyId, companyId), sql`${factoryContainers.status} != 'DELETED'`));

  // Fetch category names
  const catRows = await db
    .select({ id: factorySupplierCategories.id, name: factorySupplierCategories.name })
    .from(factorySupplierCategories)
    .where(eq(factorySupplierCategories.companyId, companyId));
  const catNameMap = new Map<number, string>(catRows.map((c) => [c.id, c.name]));

  // Map: categoryKey → { name, currentBalance }
  // categoryKey = categoryId (number) or "uncategorized"
  const catBalMap = new Map<CatKey, { name: string; currentBalance: number }>();
  const getCatKey = (categoryId: number | null | undefined): CatKey =>
    (categoryId != null ? categoryId : "uncategorized") as CatKey;
  const getCatName = (categoryId: number | null | undefined): string =>
    categoryId != null ? catNameMap.get(categoryId) || `Category ${categoryId}` : "Uncategorized";

  // 2. Stock-in per category per date
  const stockInByDate = new Map<string, Map<CatKey, number>>();
  for (const r of rawStockRows) {
    const ck = getCatKey(r.categoryId as number | null);
    const catName = getCatName(r.categoryId as number | null);
    const remaining = toMoney(r.receivedKg as string)
      .minus(toMoney(r.usedKg as string))
      .toNumber();
    if (catBalMap.has(ck)) {
      catBalMap.get(ck)!.currentBalance += remaining;
    } else {
      catBalMap.set(ck, { name: catName, currentBalance: remaining });
    }
    const dateStr = (r.offloadedAt as Date).toISOString().slice(0, 10);
    if (!stockInByDate.has(dateStr)) stockInByDate.set(dateStr, new Map());
    const dm = stockInByDate.get(dateStr)!;
    dm.set(ck, plusMoney(dm.get(ck) || 0, r.receivedKg as string));
  }

  // 2b. Manual stock adjustments (ADD/REMOVE) — these live in factoryRawMaterialAdjustments,
  //     linked to a supplierId (not a container). Include them in stock-in, consumption, and
  //     the current-balance map so the opening-balance formula stays consistent.
  const manualAdjRows = await db
    .select({
      date: factoryRawMaterialAdjustments.date,
      type: factoryRawMaterialAdjustments.type,
      kg: factoryRawMaterialAdjustments.kg,
      catId: factorySuppliers.supplierCategoryId,
      supplierName: factorySuppliers.name,
    })
    .from(factoryRawMaterialAdjustments)
    .leftJoin(factorySuppliers, eq(factoryRawMaterialAdjustments.supplierId, factorySuppliers.id))
    .where(eq(factoryRawMaterialAdjustments.companyId, companyId));

  // REMOVE adjustments are collected here and merged into consumptionByDate after step 5 builds it
  const manualRemoveByDate = new Map<string, Map<CatKey, number>>();

  for (const adj of manualAdjRows) {
    const ck = getCatKey(adj.catId as number | null);
    const catName = getCatName(adj.catId as number | null);
    const kg = toMoney(adj.kg as string).toNumber();
    if (kg <= 0) continue;
    const isAdd = adj.type === "ADD";

    // Keep catBalMap in sync: ADD increases free stock, REMOVE decreases it
    if (catBalMap.has(ck)) {
      catBalMap.get(ck)!.currentBalance += isAdd ? kg : -kg;
    } else {
      catBalMap.set(ck, { name: catName, currentBalance: isAdd ? kg : -kg });
    }

    const dateStr = _wrDateOnly(adj.date);
    if (isAdd) {
      // Treat manual ADD the same as receiving container stock
      if (!stockInByDate.has(dateStr)) stockInByDate.set(dateStr, new Map());
      const dm = stockInByDate.get(dateStr)!;
      dm.set(ck, (dm.get(ck) || 0) + kg);
    } else {
      // Treat manual REMOVE as consumption on that date
      if (!manualRemoveByDate.has(dateStr)) manualRemoveByDate.set(dateStr, new Map());
      const dm = manualRemoveByDate.get(dateStr)!;
      dm.set(ck, (dm.get(ck) || 0) + kg);
    }
  }

  // Build a lookup: containerId → actual usedKg (from factoryRawStock)
  // This is the ground-truth for how much raw material was consumed from each container.
  const containerUsedKgMap = new Map<number, number>();
  for (const r of rawStockRows) {
    containerUsedKgMap.set(r.containerId as number, toMoney(r.usedKg as string).toNumber());
  }

  // 3. Fetch mix batch sources (container-type only) with their batch dates.
  //    We will scale their weights proportionally so that the total consumption per container
  //    exactly equals factoryRawStock.usedKg — eliminating any gap from edits, reversals, or
  //    legacy data that would otherwise produce spurious negative opening balances.
  const consumptionRows = await db
    .select({
      containerId: factoryMixBatchSources.containerId,
      batchDate: factoryMixBatches.batchDate,
      batchCreatedAt: factoryMixBatches.createdAt,
      catIdViaContainer: factorySuppliers.supplierCategoryId,
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

  // Pre-compute total tracked source weight per container (raw, unscaled)
  // Used in step 5b to find the gap between actual usedKg and tracked sources.
  const sourceSumByContainer = new Map<number, number>();
  for (const r of consumptionRows) {
    const cid = r.containerId as number;
    sourceSumByContainer.set(cid, plusMoney(sourceSumByContainer.get(cid) || 0, r.weightKg as string));
  }

  // 5. Consumption map: date → categoryKey → kgConsumed
  //    Use raw source weights (unscaled). The gap between tracked sources and actual usedKg
  //    is filled in step 5b so the total per container exactly equals factoryRawStock.usedKg.
  const consumptionByDate = new Map<string, Map<CatKey, number>>();
  for (const r of consumptionRows) {
    const rawWeight = toMoney(r.weightKg as string).toNumber();
    if (rawWeight <= 0) continue;

    let dateStr: string;
    if (r.batchDate) {
      dateStr = typeof r.batchDate === "string" ? r.batchDate : (r.batchDate as Date).toISOString().slice(0, 10);
    } else {
      dateStr = (r.batchCreatedAt as Date).toISOString().slice(0, 10);
    }
    const effectiveCatId = r.catIdViaContainer as number | null;
    const ck = getCatKey(effectiveCatId);
    const catName = getCatName(effectiveCatId);
    if (!consumptionByDate.has(dateStr)) consumptionByDate.set(dateStr, new Map());
    consumptionByDate.get(dateStr)!.set(ck, (consumptionByDate.get(dateStr)!.get(ck) || 0) + rawWeight);
    if (!catBalMap.has(ck)) {
      catBalMap.set(ck, { name: catName, currentBalance: 0 });
    }
  }

  return {
    done: false as const,
    format,
    period,
    isoWeekKey,
    mondayOfWeek,
    dayName,
    fmtDate,
    periodStart,
    rawStockRows,
    catBalMap,
    getCatKey,
    getCatName,
    stockInByDate,
    manualRemoveByDate,
    sourceSumByContainer,
    consumptionByDate,
  };
}
