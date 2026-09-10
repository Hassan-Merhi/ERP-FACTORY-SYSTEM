/**
 * Shared state and helpers for the factoryPayrollRoutes routes.
 *
 * Extracted verbatim from the former single-file factoryPayrollRoutes.ts.
 */
import { factoryDaybookEntries } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import type { AttendanceStatusRow } from "../../services/payroll/factoryPayrollGenerationPolicy";

/**
 * Daybook writing and the pro-rata pay calculations shared by the payroll
 * generate, patch, undo and export handlers.
 *
 * Declared at module scope so those handlers can live in separate modules.
 */
export async function writeDaybookEntry(
  dbOrTx: DatabaseOrTransaction,
  opts: {
    companyId: number;
    txDate: string;
    txType: string;
    referenceId?: number;
    referenceTable?: string;
    description: string;
    metaJson?: string;
    currencyCode?: string;
    amountCurrency?: number;
    fxRateToUsd?: number;
    amountUsd?: number;
    createdBy?: string | null;
    effectiveDate?: string | null;
  }
) {
  const currency = opts.currencyCode || "USD";
  const fxRate = opts.fxRateToUsd || 1;
  const amtCurrency = opts.amountCurrency || 0;
  const amtUsd =
    opts.amountUsd !== undefined ? opts.amountUsd : currency === "USD" ? amtCurrency : amtCurrency * fxRate;
  await dbOrTx.insert(factoryDaybookEntries).values({
    companyId: opts.companyId,
    txDate: opts.txDate,
    txType: opts.txType,
    referenceId: opts.referenceId || null,
    referenceTable: opts.referenceTable || null,
    description: opts.description,
    metaJson: opts.metaJson || null,
    currencyCode: currency,
    amountCurrency: String(amtCurrency),
    fxRateToUsd: String(fxRate),
    amountUsd: String(amtUsd),
    createdBy: opts.createdBy || null,
    effectiveDate: opts.effectiveDate || null,
  });
}

export function countWeekdays(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  let count = 0;
  const current = new Date(s);
  while (current <= e) {
    const day = current.getDay();
    if (day !== 0 && day !== 6) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}

export function daysInPeriod(start: string, end: string): number {
  const s = new Date(start);
  const e = new Date(end);
  return Math.floor((e.getTime() - s.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

export function daysInMonth(dateStr: string): number {
  const d = new Date(dateStr);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

export function computeMonthlyPay(salary: number, startStr: string, endStr: string): number {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let total = 0;
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const monthLastDay = new Date(year, month + 1, 0);
    const daysInThisMonth = monthLastDay.getDate();
    const segStart = new Date(Math.max(cur.getTime(), start.getTime()));
    const segEnd = new Date(Math.min(monthLastDay.getTime(), end.getTime()));
    const daysInSeg = Math.floor((segEnd.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    total += salary * (daysInSeg / daysInThisMonth);
    cur = new Date(year, month + 1, 1);
  }
  return total;
}

// Compute monthly pay from actual attendance (Present/Late = 1 day, Half Day = 0.5)
export function computeMonthlyPayFromAttendance(
  baseSalary: number,
  periodStart: string,
  attendanceRows: readonly AttendanceStatusRow[]
): number {
  const daysInMonth = (dateStr: string) => {
    const d = new Date(dateStr);
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  };
  let attendedDays = 0;
  for (const row of attendanceRows) {
    const s = row.status || "Absent";
    if (s === "Present" || s === "Late" || s === "Leave") attendedDays += 1;
    else if (s === "Half Day") attendedDays += 0.5;
  }
  const daysInStartMonth = daysInMonth(periodStart);
  const dailyRate = baseSalary / daysInStartMonth;
  return attendedDays * dailyRate;
}
