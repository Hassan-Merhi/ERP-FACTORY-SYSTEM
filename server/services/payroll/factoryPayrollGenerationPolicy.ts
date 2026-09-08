/**
 * One attendance record, reduced to the only field the pay calculators read.
 *
 * `factory_attendance.status` is a free `varchar(20)`, not an enum, so a stored
 * value is genuinely just a string — the recognized values are listed in
 * `ATTENDANCE_STATUSES` for comparison, but a row is not typed as that union
 * because the database can hold anything. Rows reaching these helpers through a
 * LEFT JOIN can also carry no status at all, which the callers already treat as
 * "Absent".
 */
export interface AttendanceStatusRow {
  status?: string | null;
}

/** The attendance statuses the payroll calculators recognize. */
export const ATTENDANCE_STATUSES = ["Present", "Late", "Leave", "Half Day", "Absent"] as const;

export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface FactoryPayrollCalculationInput {
  salaryType: string | null;
  baseSalary: number;
  perBaleRate: number;
  perKgRate: number;
  overtimeRate: number;
  startDate: string;
  endDate: string;
  attendanceStatuses: Array<string | null | undefined>;
  baleWeightsKg: number[];
  outstandingAdvance: number;
}

export interface FactoryPayrollCalculationResult {
  basePay: number;
  baleEarnings: number;
  kgEarnings: number;
  overtimeHours: number;
  overtimePay: number;
  bonuses: number;
  deductions: number;
  advances: number;
  netSalary: number;
  balesCount: number;
  kgProcessed: number;
  totalWorkingDays: number;
  presentDays: number;
  absentDays: number;
}

function assertDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${label} must use YYYY-MM-DD format`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is invalid`);
  }
}

export function validateFactoryPayrollGenerationDates(startDate: string, endDate: string, txDate: string): void {
  assertDate(startDate, "startDate");
  assertDate(endDate, "endDate");
  assertDate(txDate, "txDate");
  if (startDate > endDate) throw new Error("startDate cannot be after endDate");
}

function countWeekdays(start: string, end: string): number {
  const current = new Date(`${start}T00:00:00Z`);
  const finalDate = new Date(`${end}T00:00:00Z`);
  let count = 0;
  while (current <= finalDate) {
    const day = current.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
    current.setUTCDate(current.getUTCDate() + 1);
  }
  return count;
}

function computeMonthlyPay(salary: number, start: string, end: string): number {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  let total = 0;
  let cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));

  while (cursor <= endDate) {
    const year = cursor.getUTCFullYear();
    const month = cursor.getUTCMonth();
    const monthLastDay = new Date(Date.UTC(year, month + 1, 0));
    const daysInMonth = monthLastDay.getUTCDate();
    const segmentStart = new Date(Math.max(cursor.getTime(), startDate.getTime()));
    const segmentEnd = new Date(Math.min(monthLastDay.getTime(), endDate.getTime()));
    const segmentDays = Math.floor((segmentEnd.getTime() - segmentStart.getTime()) / 86_400_000) + 1;
    total += salary * (segmentDays / daysInMonth);
    cursor = new Date(Date.UTC(year, month + 1, 1));
  }

  return total;
}

function computeMonthlyPayFromAttendance(
  baseSalary: number,
  startDate: string,
  statuses: Array<string | null | undefined>
): number {
  const start = new Date(`${startDate}T00:00:00Z`);
  const daysInMonth = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
  let attendedDays = 0;
  for (const status of statuses) {
    if (status === "Present" || status === "Late" || status === "Leave") attendedDays += 1;
    else if (status === "Half Day") attendedDays += 0.5;
  }
  return attendedDays * (baseSalary / daysInMonth);
}

export function buildFactoryPayrollGenerationLockKey(companyId: number, startDate: string, endDate: string): string {
  return `factory-payroll-generation:${companyId}:${startDate}:${endDate}`;
}

export function calculateFactoryPayroll(input: FactoryPayrollCalculationInput): FactoryPayrollCalculationResult {
  const attendanceStatuses = input.attendanceStatuses;
  const hasAttendance = attendanceStatuses.length > 0;
  let presentDays = 0;
  let absentDays = 0;

  for (const status of attendanceStatuses) {
    if (status === "Present" || status === "Late" || status === "Leave") presentDays += 1;
    else if (status === "Half Day") {
      presentDays += 0.5;
      absentDays += 0.5;
    } else if (status === "Absent") absentDays += 1;
  }

  let basePay = 0;
  let baleEarnings = 0;
  let kgEarnings = 0;
  let balesCount = 0;
  let kgProcessed = 0;

  switch (input.salaryType) {
    case "Monthly":
      basePay = hasAttendance
        ? computeMonthlyPayFromAttendance(input.baseSalary, input.startDate, attendanceStatuses)
        : computeMonthlyPay(input.baseSalary, input.startDate, input.endDate);
      break;
    case "Daily":
      basePay = input.baseSalary * (hasAttendance ? presentDays : countWeekdays(input.startDate, input.endDate));
      break;
    case "Per Bale":
      balesCount = input.baleWeightsKg.length;
      baleEarnings = balesCount * input.perBaleRate;
      break;
    case "Per KG":
      kgProcessed = input.baleWeightsKg.reduce((sum, weight) => sum + weight, 0);
      kgEarnings = kgProcessed * input.perKgRate;
      break;
    default:
      break;
  }

  const overtimeHours = 0;
  const overtimePay = overtimeHours * input.overtimeRate;
  const bonuses = 0;
  const deductions = 0;
  const grossPay = basePay + baleEarnings + kgEarnings + overtimePay + bonuses;
  const advances = Math.min(Math.max(0, input.outstandingAdvance), grossPay);
  const netSalary = grossPay - deductions - advances;

  return {
    basePay,
    baleEarnings,
    kgEarnings,
    overtimeHours,
    overtimePay,
    bonuses,
    deductions,
    advances,
    netSalary,
    balesCount,
    kgProcessed,
    totalWorkingDays: countWeekdays(input.startDate, input.endDate),
    presentDays,
    absentDays,
  };
}
