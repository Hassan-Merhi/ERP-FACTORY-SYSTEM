/**
 * Pure helpers and lookup tables for the FactoryWorkerAttendanceReport page.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the Phase 4 god-file split.
 */

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
  Leave: "Half Day",
  "Half Day": "",
  HalfDay: "", // backward-compatible display/edit of legacy values
  "": "Present",
};

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
