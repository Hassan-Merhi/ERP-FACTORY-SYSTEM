// Extracted from ./weekly-report.ts: a stage of weekly-report.
import { toMoney } from "../../../lib/money";
import type { Response } from "express";
import type { weeklyReportStep, CatKey } from "./weeklyReportStep";

type WeeklyReportStepResult = Awaited<ReturnType<typeof weeklyReportStep>>;

export async function weeklyReportStep2({
  wkr1,
  res,
}: {
  wkr1: Extract<WeeklyReportStepResult, { done: false }>;
  res: Response;
}) {
  const {
    rawStockRows,
    sourceSumByContainer,
    getCatKey,
    getCatName,
    consumptionByDate,
    catBalMap,
    manualRemoveByDate,
    stockInByDate,
    isoWeekKey,
    format,
    periodStart,
    mondayOfWeek,
    period,
  } = wkr1;

  // 5b. Close the "no-source" gap: any container whose usedKg exceeds the sum of its tracked
  //     mix-batch sources has un-dated consumption. Attribute that gap to the container's
  //     offloadedAt date so the opening-balance formula always collapses to exactly zero.
  for (const r of rawStockRows) {
    const cid = r.containerId as number;
    const actualUsed = toMoney(r.usedKg as string).toNumber();
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
      return { done: true as const, value: res.end(xlsBuffer2) };
    }
    return { done: true as const, value: res.json({ message: "No data" }) };
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
    for (const [ck, v] of weekConsumption.get(wk)!) totalConsumptionAll.set(ck, (totalConsumptionAll.get(ck) || 0) + v);
  }

  const openingBalances = new Map<string, Map<CatKey, number>>();
  const closingBalances = new Map<string, Map<CatKey, number>>();
  const firstOpening = new Map<CatKey, number>(
    allCatKeys.map((ck) => [
      ck,
      (catBalMap.get(ck)?.currentBalance || 0) - (totalStockInAll.get(ck) || 0) + (totalConsumptionAll.get(ck) || 0),
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

  const periodLabel: "This Week" | "This Month" | "This Year" | "All Time" =
    period === "week" ? "This Week" : period === "month" ? "This Month" : period === "year" ? "This Year" : "All Time";

  return {
    done: false as const,
    weekMap,
    allCatKeys,
    weekConsumption,
    weekStockIn,
    openingBalances,
    displayWeekKeys,
    periodLabel,
  };
}
