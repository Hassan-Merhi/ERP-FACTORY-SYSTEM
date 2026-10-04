/**
 * Pure helpers and lookup tables for the FactoryWorkerAttendanceReport page.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the Phase 4 god-file split.
 */

import type {DateEntry, WorkerReportRow} from "./types";

function formatLocalIsoDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export /* ── Helpers ────────────────────────────────────────────────────────────────── */
function isoToday() {
  return formatLocalIsoDate(new Date());
}

export function isoYesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return formatLocalIsoDate(d);
}

export function isoMonthStart() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

export function isoMonthEnd() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return formatLocalIsoDate(last);
}

export function workerCodeNum(code: string | null): number {
  if (!code) return Infinity;
  const m = code.match(/(\d+)$/);
  return m ? parseInt(m[1], 10) : Infinity;
}

export const CYCLE: Record<string, string> = {
  Present: "Absent",
  Absent: "Leave",
  Leave: "HalfDay",
  HalfDay: "",
  "": "Present",
};

/* ── Salary helpers ─────────────────────────────────────────────────────────── */

export /* ── Salary helpers ─────────────────────────────────────────────────────────── */
function daysInCalendarMonth(isoDate: string): number {
  const [yr, mo] = isoDate.substring(0, 7).split("-").map(Number);
  return new Date(yr, mo, 0).getDate();
}

export function computeWorkerExpectedSalary(worker: WorkerReportRow, dates: DateEntry[]): number {
  if (worker.salaryType !== "Monthly") return 0;
  const monthly = parseFloat(worker.baseSalary || "0");
  const transport = parseFloat(worker.transportAllowance || "0");
  const total = monthly + transport;
  if (!total || !dates.length) return 0;
  let earned = 0;
  for (const d of dates) {
    const dailyRate = monthly / daysInCalendarMonth(d.date);
    if (d.isWeekend) {
      earned += dailyRate;
    } else {
      const status = worker.attendance[d.date];
      if (status === "Present") earned += dailyRate;
      else if (status === "HalfDay") earned += dailyRate * 0.5;
      else if (status === "Leave") earned += dailyRate;
    }
  }
  // Add full monthly transport allowance (not prorated — it's a flat monthly benefit)
  earned += transport;
  return earned;
}

export function fmtCurrency(n: number | null | undefined): string {
  if (n == null || isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/* ── Status Cell ────────────────────────────────────────────────────────────── */
