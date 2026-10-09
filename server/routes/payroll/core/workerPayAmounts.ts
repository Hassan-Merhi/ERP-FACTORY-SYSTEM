/**
 * The per-worker payroll amounts, shared by the preview and by generation so
 * the figures a user approves in the preview are the ones that get stored.
 *
 * Every component is taken at cents, so base + bonus + transport − advance
 * deduction − pending deductions equals the stored net exactly.
 */
import type Decimal from "decimal.js";
import { MoneyDecimal, toMoney } from "../../../lib/money";

export interface PayrollWorkerInput {
  baseSalary: string | null;
  weeklySalary?: string | null;
  biWeeklySalary?: string | null;
  payFrequency?: string | null;
  salaryType?: string | null;
  transportAllowance?: string | null;
}

export interface PayrollAttendanceInput {
  status: string | null;
}

export interface WorkerPayInput {
  worker: PayrollWorkerInput;
  days: number;
  periodStart: string;
  periodEnd: string;
  attendance: PayrollAttendanceInput[];
  /** Bonus per worker, already at cents. */
  bonus: Decimal;
  /** Monthly transport override for this worker, or null for the worker's own allowance. */
  transportOverride: Decimal | null;
  /** Outstanding salary-deduction advance balance. */
  advanceBalance: Decimal;
  /** User-approved advance deduction, or null to deduct as much of the balance as the gross allows. */
  advanceOverride: Decimal | null;
  /** Pending one-time deductions not yet applied. */
  pendingDeductions: Decimal;
}

export interface WorkerPayAmounts {
  base: Decimal;
  transport: Decimal;
  transportMonthly: Decimal;
  gross: Decimal;
  advanceDeduction: Decimal;
  pendingDeductions: Decimal;
  net: Decimal;
  presentDays: number;
}

export function daysInMonthOf(date: string): number {
  const d = new Date(date);
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

/**
 * Monthly salary prorated by calendar days, month by month across the period.
 * Same rule as computeMonthlyPay in ./_helpers, in exact decimals.
 */
export function exactMonthlyPay(salary: Decimal, startStr: string, endStr: string): Decimal {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let total: Decimal = new MoneyDecimal(0);
  let cur = new Date(start.getFullYear(), start.getMonth(), 1);
  while (cur <= end) {
    const year = cur.getFullYear();
    const month = cur.getMonth();
    const monthLastDay = new Date(year, month + 1, 0);
    const segStart = new Date(Math.max(cur.getTime(), start.getTime()));
    const segEnd = new Date(Math.min(monthLastDay.getTime(), end.getTime()));
    const daysInSeg = Math.floor((segEnd.getTime() - segStart.getTime()) / (1000 * 60 * 60 * 24)) + 1;
    total = total.plus(salary.times(daysInSeg).div(monthLastDay.getDate()));
    cur = new Date(year, month + 1, 1);
  }
  return total;
}

/**
 * Monthly salary paid for attended days (Present/Late = 1, Half Day = 0.5) at
 * salary / days in the period's first month. Same rule as
 * computeMonthlyPayFromAttendance in ./_helpers, in exact decimals.
 */
export function exactMonthlyPayFromAttendance(
  salary: Decimal,
  periodStart: string,
  attendance: readonly { status: string | null }[]
): Decimal {
  let attendedDays = 0;
  for (const row of attendance) {
    const s = row.status || "Absent";
    if (s === "Present" || s === "Late") attendedDays += 1;
    else if (s === "Half Day") attendedDays += 0.5;
  }
  return salary.times(attendedDays).div(daysInMonthOf(periodStart));
}

/** Present, Late and Leave count as a day; Half Day as half. */
export function presentDaysOf(attendance: PayrollAttendanceInput[]): number {
  let presentDays = 0;
  for (const att of attendance) {
    if (att.status === "Present" || att.status === "Late" || att.status === "Leave") presentDays += 1;
    else if (att.status === "Half Day") presentDays += 0.5;
  }
  return presentDays;
}

export function computeWorkerPayAmounts(input: WorkerPayInput): WorkerPayAmounts {
  const { worker, days, periodStart, periodEnd, attendance, bonus } = input;
  const baseSalary = toMoney(worker.baseSalary);
  const freq = worker.payFrequency || worker.salaryType || "Monthly";

  let exactBase: Decimal;
  if (freq === "Weekly")
    exactBase = toMoney(worker.weeklySalary || baseSalary)
      .times(days)
      .div(7);
  else if (freq === "Bi-Weekly")
    exactBase = toMoney(worker.biWeeklySalary || baseSalary)
      .times(days)
      .div(14);
  else if (freq === "Daily" || worker.salaryType === "Daily") exactBase = baseSalary.times(days);
  else if (attendance.length === 0) exactBase = exactMonthlyPay(baseSalary, periodStart, periodEnd);
  else exactBase = exactMonthlyPayFromAttendance(baseSalary, periodStart, attendance);
  const base = exactBase.toDecimalPlaces(2);

  // Transport is prorated over the whole month's days, not the period's, so two
  // half-month runs add up to exactly the monthly allowance.
  const presentDays = presentDaysOf(attendance);
  const monthDays = daysInMonthOf(periodStart);
  const transportMonthly = input.transportOverride ?? toMoney(worker.transportAllowance);
  let exactTransport: Decimal = new MoneyDecimal(0);
  if (transportMonthly.gt(0)) {
    exactTransport =
      attendance.length > 0 && monthDays > 0 ? transportMonthly.times(presentDays).div(monthDays) : transportMonthly;
  }
  const transport = exactTransport.toDecimalPlaces(2);

  const gross = base.plus(bonus).plus(transport);
  const advanceDeduction = (
    input.advanceOverride
      ? MoneyDecimal.min(input.advanceOverride, gross, input.advanceBalance)
      : MoneyDecimal.min(input.advanceBalance, gross)
  ).toDecimalPlaces(2);
  const pendingDeductions = input.pendingDeductions.toDecimalPlaces(2);
  const net = gross.minus(advanceDeduction).minus(pendingDeductions);

  return { base, transport, transportMonthly, gross, advanceDeduction, pendingDeductions, net, presentDays };
}
