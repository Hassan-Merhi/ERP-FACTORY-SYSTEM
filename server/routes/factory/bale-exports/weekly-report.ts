/**
 * factoryBaleExportRoutes: FactoryWeeklyReportExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
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
import path from "path";
import fs from "fs";

export function registerFactoryWeeklyReportExportRoutes(app: Express) {
  // ───────────────────────────────────────────────
  // Weekly pivot production report (by category × day)
  // ───────────────────────────────────────────────
  app.get("/api/factory/weekly-report/export", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
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
      type CatKey = number | "uncategorized";
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
        const remaining = (parseFloat(r.receivedKg as string) || 0) - (parseFloat(r.usedKg as string) || 0);
        if (catBalMap.has(ck)) {
          catBalMap.get(ck)!.currentBalance += remaining;
        } else {
          catBalMap.set(ck, { name: catName, currentBalance: remaining });
        }
        const dateStr = (r.offloadedAt as Date).toISOString().slice(0, 10);
        if (!stockInByDate.has(dateStr)) stockInByDate.set(dateStr, new Map());
        const dm = stockInByDate.get(dateStr)!;
        dm.set(ck, (dm.get(ck) || 0) + (parseFloat(r.receivedKg as string) || 0));
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
        const kg = parseFloat(adj.kg as string) || 0;
        if (kg <= 0) continue;
        const isAdd = adj.type === "ADD";

        // Keep catBalMap in sync: ADD increases free stock, REMOVE decreases it
        if (catBalMap.has(ck)) {
          catBalMap.get(ck)!.currentBalance += isAdd ? kg : -kg;
        } else {
          catBalMap.set(ck, { name: catName, currentBalance: isAdd ? kg : -kg });
        }

        const dateStr =
          typeof adj.date === "string" ? adj.date.slice(0, 10) : (adj.date as any).toISOString().slice(0, 10);
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
        containerUsedKgMap.set(r.containerId as number, parseFloat(r.usedKg as string) || 0);
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
        sourceSumByContainer.set(cid, (sourceSumByContainer.get(cid) || 0) + (parseFloat(r.weightKg as string) || 0));
      }

      // 5. Consumption map: date → categoryKey → kgConsumed
      //    Use raw source weights (unscaled). The gap between tracked sources and actual usedKg
      //    is filled in step 5b so the total per container exactly equals factoryRawStock.usedKg.
      const consumptionByDate = new Map<string, Map<CatKey, number>>();
      for (const r of consumptionRows) {
        const rawWeight = parseFloat(r.weightKg as string) || 0;
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

      // 5b. Close the "no-source" gap: any container whose usedKg exceeds the sum of its tracked
      //     mix-batch sources has un-dated consumption. Attribute that gap to the container's
      //     offloadedAt date so the opening-balance formula always collapses to exactly zero.
      for (const r of rawStockRows) {
        const cid = r.containerId as number;
        const actualUsed = parseFloat(r.usedKg as string) || 0;
        if (actualUsed <= 0) continue;
        const sourceTotal = sourceSumByContainer.get(cid) || 0;
        const gap = actualUsed - sourceTotal;
        if (gap <= 0.001) continue; // no gap or fully covered by sources

        const dateStr = (r.offloadedAt as Date).toISOString().slice(0, 10);
        const ck = getCatKey(r.categoryId as number | null);
        const catName = getCatName(r.categoryId as number | null);
        if (!consumptionByDate.has(dateStr)) consumptionByDate.set(dateStr, new Map());
        consumptionByDate.get(dateStr)!.set(ck, (consumptionByDate.get(dateStr)!.get(ck) || 0) + gap);
        if (!catBalMap.has(ck)) catBalMap.set(ck, { name: catName, currentBalance: 0 });
      }

      // 5c. Merge manual REMOVE adjustments into consumptionByDate
      for (const [dateStr, catMap] of manualRemoveByDate) {
        if (!consumptionByDate.has(dateStr)) consumptionByDate.set(dateStr, new Map());
        const dm = consumptionByDate.get(dateStr)!;
        for (const [ck, kg] of catMap) {
          dm.set(ck, (dm.get(ck) || 0) + kg);
        }
      }

      // 6. Build week map from ALL dates (for correct opening balance computation)
      const allDates = new Set<string>([...consumptionByDate.keys(), ...stockInByDate.keys()]);
      const weekMap = new Map<string, string[]>();
      for (const d of allDates) {
        const wk = isoWeekKey(d);
        if (!weekMap.has(wk)) weekMap.set(wk, []);
        weekMap.get(wk)!.push(d);
      }
      const sortedWeekKeys = [...weekMap.keys()].sort();
      for (const wk of sortedWeekKeys) weekMap.get(wk)!.sort();

      if (sortedWeekKeys.length === 0) {
        if (format === "excel") {
          const ExcelJS = (await import("exceljs")).default;
          const wb = new ExcelJS.Workbook();
          const sh = wb.addWorksheet("Weekly Report");
          sh.addRow(["No data found"]);
          const xlsBuffer2 = Buffer.from(await wb.xlsx.writeBuffer());
          res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
          res.setHeader("Content-Disposition", `attachment; filename="weekly-production-report.xlsx"`);
          res.setHeader("Content-Length", xlsBuffer2.byteLength);
          return res.end(xlsBuffer2);
        }
        return res.json({ message: "No data" });
      }

      // 7. Compute opening/closing balances forward from week 1 (all weeks, no filter yet)
      const allCatKeys = [...catBalMap.keys()];
      const weekConsumption = new Map<string, Map<CatKey, number>>();
      const weekStockIn = new Map<string, Map<CatKey, number>>();
      for (const wk of sortedWeekKeys) {
        const cMap = new Map<CatKey, number>();
        const sMap = new Map<CatKey, number>();
        for (const d of weekMap.get(wk)!) {
          for (const [ck, kg] of consumptionByDate.get(d) || new Map()) cMap.set(ck, (cMap.get(ck) || 0) + kg);
          for (const [ck, kg] of stockInByDate.get(d) || new Map()) sMap.set(ck, (sMap.get(ck) || 0) + kg);
        }
        weekConsumption.set(wk, cMap);
        weekStockIn.set(wk, sMap);
      }

      // Compute total stock-in and total consumption across ALL historical weeks so we can
      // back-calculate the true opening balance of the very first week.
      // Invariant: currentBalance = firstOpening + totalStockIn − totalConsumption
      // → firstOpening = currentBalance − totalStockIn + totalConsumption
      const totalStockInAll = new Map<CatKey, number>();
      const totalConsumptionAll = new Map<CatKey, number>();
      for (const wk of sortedWeekKeys) {
        for (const [ck, v] of weekStockIn.get(wk)!) totalStockInAll.set(ck, (totalStockInAll.get(ck) || 0) + v);
        for (const [ck, v] of weekConsumption.get(wk)!)
          totalConsumptionAll.set(ck, (totalConsumptionAll.get(ck) || 0) + v);
      }

      const openingBalances = new Map<string, Map<CatKey, number>>();
      const closingBalances = new Map<string, Map<CatKey, number>>();
      const firstOpening = new Map<CatKey, number>(
        allCatKeys.map((ck) => [
          ck,
          (catBalMap.get(ck)?.currentBalance || 0) -
            (totalStockInAll.get(ck) || 0) +
            (totalConsumptionAll.get(ck) || 0),
        ])
      );
      openingBalances.set(sortedWeekKeys[0], firstOpening);
      for (let i = 0; i < sortedWeekKeys.length; i++) {
        const wk = sortedWeekKeys[i];
        const opening = openingBalances.get(wk)!;
        const closing = new Map<CatKey, number>();
        for (const ck of allCatKeys) {
          closing.set(
            ck,
            (opening.get(ck) || 0) + (weekStockIn.get(wk)!.get(ck) || 0) - (weekConsumption.get(wk)!.get(ck) || 0)
          );
        }
        closingBalances.set(wk, closing);
        if (i < sortedWeekKeys.length - 1) openingBalances.set(sortedWeekKeys[i + 1], closing);
      }

      // Apply period filter — only display weeks within the selected range.
      // We include a week if ANY of its activity dates falls on or after the period start.
      const displayWeekKeys = periodStart
        ? sortedWeekKeys.filter((wk) => {
            const dates = weekMap.get(wk)!;
            // Include the week if its LAST recorded date is >= period start,
            // OR if the week's Monday falls within the period (handles partially-started weeks)
            const lastDate = dates[dates.length - 1];
            const monDate = mondayOfWeek(dates[0]);
            return lastDate >= periodStart! || monDate >= periodStart!;
          })
        : sortedWeekKeys;

      const periodLabel =
        period === "week"
          ? "This Week"
          : period === "month"
            ? "This Month"
            : period === "year"
              ? "This Year"
              : "All Time";

      // 8. Excel generation
      if (format === "excel") {
        const ExcelJS = (await import("exceljs")).default;
        const wb = new ExcelJS.Workbook();
        const sh = wb.addWorksheet("Weekly Report");

        const BLUE = "FF1E40AF";
        const LIGHT_BLUE = "FFE0EAFF";
        const DARK_GRAY = "FF374151";
        const TOTAL_BG = "FFD1FAE5";
        const BORDER_STYLE: import("exceljs").Border = { style: "thin", color: { argb: "FFD1D5DB" } };
        const BORDER_ALL = { top: BORDER_STYLE, left: BORDER_STYLE, bottom: BORDER_STYLE, right: BORDER_STYLE };

        sh.getColumn(1).width = 24;
        sh.getColumn(2).width = 14;
        sh.getColumn(3).width = 12;

        let row = 1;

        if (displayWeekKeys.length === 0) {
          const msgRow = sh.getRow(row);
          const msgCell = msgRow.getCell(1);
          msgCell.value = `No production data found for period: ${periodLabel}`;
          msgCell.font = { italic: true, size: 11 };
          sh.mergeCells(row, 1, row, 12);
          row++;
        }

        for (const wk of displayWeekKeys) {
          const dates = weekMap.get(wk)!;
          const monDate = mondayOfWeek(dates[0]);
          const monD = new Date(monDate + "T00:00:00");
          const weekDaysMoSa: string[] = [];
          for (let di = 0; di < 7; di++) {
            const d = new Date(monD);
            d.setUTCDate(monD.getUTCDate() + di);
            weekDaysMoSa.push(d.toISOString().slice(0, 10));
          }

          const totalCols = 3 + weekDaysMoSa.length + 2; // CATEGORY + Balance + StockIn + days + TOTAL + REMAINS

          // ── Title row ──
          const titleRow = sh.getRow(row);
          const titleText = `Week of ${fmtDate(monDate)} – ${fmtDate(weekDaysMoSa[6])}  |  ${wk}`;
          const titleCell = titleRow.getCell(1);
          titleCell.value = titleText;
          titleCell.font = { bold: true, size: 11, color: { argb: "FFFFFFFF" } };
          titleCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: BLUE } };
          titleCell.alignment = { horizontal: "center", vertical: "middle" };
          sh.mergeCells(row, 1, row, totalCols);
          titleRow.height = 22;
          row++;

          // ── Column header row ──
          const colHeaders = [
            "CATEGORY",
            "Balance",
            "Stock In",
            ...weekDaysMoSa.map((d) => `${dayName(d)}\n${fmtDate(d)}`),
            "TOTAL",
            "REMAINS",
          ];
          const headerRow = sh.getRow(row);
          colHeaders.forEach((h, ci) => {
            const cell = headerRow.getCell(ci + 1);
            cell.value = h;
            cell.font = { bold: true, size: 9, color: { argb: "FFFFFFFF" } };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: DARK_GRAY } };
            cell.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
            cell.border = BORDER_ALL;
          });
          // Set day column widths
          for (let di = 0; di < weekDaysMoSa.length; di++) {
            sh.getColumn(4 + di).width = 10;
          }
          sh.getColumn(4 + weekDaysMoSa.length).width = 11;
          sh.getColumn(5 + weekDaysMoSa.length).width = 12;
          headerRow.height = 28;
          row++;

          const opening = openingBalances.get(wk)!;
          const sMap = weekStockIn.get(wk)!;

          // Active categories this week: only include categories with actual activity
          // (stock-in or consumption). Categories with only a carry-over balance are hidden.
          const activeCats = allCatKeys
            .filter((ck) => {
              return (weekConsumption.get(wk)!.get(ck) || 0) > 0.001 || (sMap.get(ck) || 0) > 0.001;
            })
            .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));

          let weekTotalBalance = 0,
            weekTotalStockIn = 0,
            weekTotalTotal = 0,
            weekTotalRemains = 0;
          const weekTotalByDay = weekDaysMoSa.map(() => 0);

          for (const ck of activeCats) {
            const info = catBalMap.get(ck)!;
            const openBal = opening.get(ck) || 0;
            const stockIn = sMap.get(ck) || 0;
            const dayVals = weekDaysMoSa.map((d) => consumptionByDate.get(d)?.get(ck) || 0);
            // Use authoritative weekConsumption (includes all 7 days) for TOTAL and REMAINS
            const total = weekConsumption.get(wk)!.get(ck) || 0;
            const remains = openBal + stockIn - total;

            weekTotalBalance += openBal;
            weekTotalStockIn += stockIn;
            weekTotalTotal += total;
            weekTotalRemains += remains;
            dayVals.forEach((v, i) => {
              weekTotalByDay[i] += v;
            });

            const dataRow = sh.getRow(row);
            const vals: (string | number | null)[] = [
              info.name,
              Math.round(openBal) || 0,
              stockIn > 0.5 ? Math.round(stockIn) : null,
              ...dayVals.map((v) => (v > 0.5 ? Math.round(v) : null)),
              Math.round(total) > 0 ? Math.round(total) : null,
              Math.round(remains),
            ];
            vals.forEach((v, ci) => {
              const cell = dataRow.getCell(ci + 1);
              cell.value = v;
              cell.font = { size: 9 };
              cell.border = BORDER_ALL;
              if (ci === 0) {
                cell.font = { size: 9, bold: true };
                cell.alignment = { vertical: "middle" };
              } else {
                cell.alignment = { horizontal: "right", vertical: "middle" };
                cell.numFmt = "#,##0";
              }
              if (ci >= 3 && ci < 3 + weekDaysMoSa.length && typeof v === "number") {
                cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: LIGHT_BLUE } };
              }
            });
            dataRow.height = 16;
            row++;
          }

          // ── Totals row ──
          const totRow = sh.getRow(row);
          const totVals: (string | number | null)[] = [
            "TOTAL",
            Math.round(weekTotalBalance),
            weekTotalStockIn > 0.5 ? Math.round(weekTotalStockIn) : null,
            ...weekTotalByDay.map((v) => (Math.round(v) > 0 ? Math.round(v) : null)),
            Math.round(weekTotalTotal) > 0 ? Math.round(weekTotalTotal) : null,
            Math.round(weekTotalRemains),
          ];
          totVals.forEach((v, ci) => {
            const cell = totRow.getCell(ci + 1);
            cell.value = v;
            cell.font = { bold: true, size: 9 };
            cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: TOTAL_BG } };
            cell.border = BORDER_ALL;
            if (ci === 0) {
              cell.alignment = { vertical: "middle" };
            } else {
              cell.alignment = { horizontal: "right", vertical: "middle" };
              cell.numFmt = "#,##0";
            }
          });
          totRow.height = 18;
          row++;

          row++; // blank gap between weeks
        }

        const xlsBuffer3 = Buffer.from(await wb.xlsx.writeBuffer());
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.setHeader("Content-Disposition", `attachment; filename="weekly-production-report.xlsx"`);
        res.setHeader("Content-Length", xlsBuffer3.byteLength);
        return res.end(xlsBuffer3);
      }

      // PDF format
      if (format === "pdf") {
        const PDFDocument = (await import("pdfkit")).default;
        const doc = new PDFDocument({ margin: 30, size: "A4", layout: "landscape" });
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="weekly-production-report.pdf"`);
        doc.pipe(res);

        const pageW = doc.page.width - 60;
        const rowH = 14;
        const wpLogoPath = path.join(process.cwd(), "server", "hmd-logo.png");

        // Show "no data" page when the selected period has no weeks
        if (displayWeekKeys.length === 0) {
          const hasLogo = fs.existsSync(wpLogoPath);
          if (hasLogo) {
            try {
              doc.image(wpLogoPath, (doc.page.width - 220) / 2, 10, { width: 220 });
            } catch {
              // Failure here is non-fatal and the surrounding flow continues deliberately.
            }
            if (doc.y < 130) doc.y = 130;
            doc.moveDown(0.5);
          }
          doc
            .fontSize(13)
            .font("Helvetica-Bold")
            .text(`No production data found for period: ${periodLabel}`, 30, doc.y, { width: pageW, align: "center" });
          doc.end();
          return;
        }

        for (let wi = 0; wi < displayWeekKeys.length; wi++) {
          const wk = displayWeekKeys[wi];
          if (wi > 0) doc.addPage({ layout: "landscape" });

          // On the first page, place logo at top then continue below it.
          // On subsequent pages start from the top margin.
          let startY = 30; // default top margin
          if (wi === 0 && fs.existsSync(wpLogoPath)) {
            try {
              doc.image(wpLogoPath, (doc.page.width - 220) / 2, 10, { width: 220 });
              // Ensure we start below the logo — use whichever is lower: doc.y or a minimum clearance
              startY = Math.max(doc.y + 8, 130);
            } catch {
              startY = 30;
            }
          }

          const dates = weekMap.get(wk)!;
          const monDate = mondayOfWeek(dates[0]);
          const monD = new Date(monDate + "T00:00:00");
          const weekDaysMoSa: string[] = [];
          for (let di = 0; di < 7; di++) {
            const d = new Date(monD);
            d.setUTCDate(monD.getUTCDate() + di);
            weekDaysMoSa.push(d.toISOString().slice(0, 10));
          }

          const nDays = 7;
          const fixedW = 120 + 65 + 55 + 58 + 65;
          const dayW = Math.max(36, Math.floor((pageW - fixedW) / nDays));
          const colWidths = [120, 65, 55, ...Array(nDays).fill(dayW), 58, 65];
          const colX: number[] = [30];
          for (let i = 1; i < colWidths.length; i++) colX.push(colX[i - 1] + colWidths[i - 1]);

          const titleText = `Week ${wk}  |  ${fmtDate(monDate)} – ${fmtDate(weekDaysMoSa[6])}`;
          doc.fontSize(11).font("Helvetica-Bold").text(titleText, 30, startY, { width: pageW, align: "center" });
          doc.moveDown(0.3);

          const headers = [
            "CATEGORY",
            "Balance",
            "Stock In",
            ...weekDaysMoSa.map((d) => `${dayName(d)}\n${fmtDate(d)}`),
            "TOTAL",
            "REMAINS",
          ];
          const hy = doc.y;
          doc.fontSize(7).font("Helvetica-Bold");
          headers.forEach((h, i) => {
            const lines = h.split("\n");
            lines.forEach((line, li) => {
              doc.text(line, colX[i], hy + li * 8, {
                width: colWidths[i] - 2,
                align: i === 0 ? "left" : "right",
                lineBreak: false,
              });
            });
          });
          const hh = rowH + (headers.some((h) => h.includes("\n")) ? 8 : 0);
          const lineY = hy + hh;
          doc
            .moveTo(30, lineY)
            .lineTo(30 + colWidths.reduce((a, b) => a + b, 0), lineY)
            .stroke();

          const opening = openingBalances.get(wk)!;
          const sMap = weekStockIn.get(wk)!;
          const activeCats = allCatKeys
            .filter((ck) => (weekConsumption.get(wk)!.get(ck) || 0) > 0 || (sMap.get(ck) || 0) > 0)
            .sort((a, b) => (catBalMap.get(a)?.name || "").localeCompare(catBalMap.get(b)?.name || ""));

          let weekTotalBalance = 0,
            weekTotalStockIn = 0,
            weekTotalTotal = 0,
            weekTotalRemains = 0;
          const weekTotalByDay = Array(nDays).fill(0);
          let rowY = lineY + 3;
          doc.font("Helvetica").fontSize(7);

          for (const ck of activeCats) {
            const info = catBalMap.get(ck)!;
            const openBal = opening.get(ck) || 0;
            const stockIn = sMap.get(ck) || 0;
            const dayVals = weekDaysMoSa.map((d) => consumptionByDate.get(d)?.get(ck) || 0);
            // Use authoritative weekConsumption (includes all 7 days) for TOTAL and REMAINS
            const total = weekConsumption.get(wk)!.get(ck) || 0;
            const remains = openBal + stockIn - total;
            weekTotalBalance += openBal;
            weekTotalStockIn += stockIn;
            weekTotalTotal += total;
            weekTotalRemains += remains;
            dayVals.forEach((v, i) => {
              weekTotalByDay[i] += v;
            });

            const rowVals = [
              info.name,
              Math.round(openBal).toLocaleString(),
              stockIn > 0.5 ? Math.round(stockIn).toLocaleString() : "-",
              ...dayVals.map((v) => (v > 0.5 ? Math.round(v).toLocaleString() : "-")),
              total > 0.5 ? Math.round(total).toLocaleString() : "-",
              Math.round(remains).toLocaleString(),
            ];
            rowVals.forEach((v, i) => {
              doc.text(String(v), colX[i], rowY, {
                width: colWidths[i] - 2,
                align: i === 0 ? "left" : "right",
                lineBreak: false,
              });
            });
            rowY += rowH;
          }

          doc
            .moveTo(30, rowY)
            .lineTo(30 + colWidths.reduce((a, b) => a + b, 0), rowY)
            .strokeColor("#000000")
            .stroke();
          rowY += 3;
          doc.font("Helvetica-Bold").fontSize(7);
          const totVals = [
            "TOTAL",
            Math.round(weekTotalBalance).toLocaleString(),
            weekTotalStockIn > 0.5 ? Math.round(weekTotalStockIn).toLocaleString() : "-",
            ...weekTotalByDay.map((v) => (v > 0.5 ? Math.round(v).toLocaleString() : "-")),
            weekTotalTotal > 0.5 ? Math.round(weekTotalTotal).toLocaleString() : "-",
            Math.round(weekTotalRemains).toLocaleString(),
          ];
          totVals.forEach((v, i) => {
            doc.text(String(v), colX[i], rowY, {
              width: colWidths[i] - 2,
              align: i === 0 ? "left" : "right",
              lineBreak: false,
            });
          });
        }

        doc.end();
        return;
      }

      return res.status(400).json({ message: "Invalid format." });
    } catch (error: unknown) {
      logger.error("Error generating weekly report:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}
