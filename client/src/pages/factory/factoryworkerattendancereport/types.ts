/**
 * Types for the FactoryWorkerAttendanceReport page.
 *
 * Extracted from FactoryWorkerAttendanceReport.tsx during the Phase 4 god-file split.
 */

export /* ── Types ─────────────────────────────────────────────────────────────────── */
interface DateEntry {
  date: string;
  label: string;
  abbr: string;
  isWeekend: boolean;
}

export interface WorkerReportRow {
  id: number;
  employeeCode: string;
  fullName: string;
  /** Inactive workers are included only when they have recorded payroll for the selected period. */
  active?: boolean;
  attendance: Record<string, string>;
  presentCount: number;
  absentCount: number;
  recordedCount: number;
  attendancePct: number | null;
  baseSalary: string;
  salaryType: string;
  transportAllowance: string;
  expectedSalary: string;
  paidSalary: string;
  remainingSalary: string;
  cashPaidSalary: string;
  advancesSettled: string;
  salarySource: "payroll" | "attendance_estimate";
}

export interface AttendanceReportData {
  startDate: string;
  endDate: string;
  dates: DateEntry[];
  workers: WorkerReportRow[];
  dailySummary: Record<string, { present: number; absent: number }>;
  totals: {
    workers: number;
    activeWorkers?: number;
    inactiveWorkers?: number;
    presentDays: number;
    absentDays: number;
    totalPossibleDays: number;
  };
}

export type AttendanceFilter = "all" | "absent" | "present";

export type DateMode = "today" | "yesterday" | "thisMonth" | "custom";

/* ── Helpers ────────────────────────────────────────────────────────────────── */
