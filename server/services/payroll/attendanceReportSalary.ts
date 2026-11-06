/**
 * Attendance-report payroll reconciliation. The reported "paid salary" is the
 * settled value of payroll (cash disbursement + salary advances already paid),
 * NOT a second deduction of advances from expected salary.
 *
 * Authoritative payroll rows take precedence over attendance estimates.
 * Historical payroll periods are immutable for reporting purposes: never
 * recalculate posted wages from a worker's current base salary.
 */
import { MoneyDecimal, toMoney } from "../../lib/money";
import { validateAttendanceReportDateRange } from "@shared/attendanceReportDateRange";
import { calculateFactoryPayroll } from "./factoryPayrollGenerationPolicy";

export interface AttendanceReportPayrollRecord {
  id: number;
  workerId: number;
  periodStart: string;
  periodEnd: string;
  status: string;
  netSalary: string;
  advances: string;
}

export interface AttendanceReportSalaryInput {
  startDate: string;
  endDate: string;
  salaryType: string;
  baseSalary: string;
  transportAllowance: string;
  attendance: Record<string, string>;
  payrolls: AttendanceReportPayrollRecord[];
}

export interface AttendanceReportSalaryResult {
  expectedSalary: string;
  paidSalary: string;
  remainingSalary: string;
  cashPaidSalary: string;
  advancesSettled: string;
  salarySource: "payroll" | "attendance_estimate";
}

const zero = () => new MoneyDecimal(0);
const money = (value: string | number | null | undefined) => toMoney(value ?? "0");
const isPaid = (row: AttendanceReportPayrollRecord) => row.status.toUpperCase() === "PAID";

/**
 * Select non-overlapping, entirely covered payroll periods.
 *
 * A full-month payroll supersedes prior shorter draft or paid calculations for
 * the same days. Disjoint weekly periods remain additive. An overlapping
 * monthly record must not be counted in a request for an unrelated day range.
 */
export function selectAttendanceReportPayrolls(
  payrolls: AttendanceReportPayrollRecord[],
  startDate: string,
  endDate: string
): AttendanceReportPayrollRecord[] {
  if (
    typeof startDate !== "string" ||
    typeof endDate !== "string" ||
    validateAttendanceReportDateRange(startDate, endDate) !== null
  ) {
    throw new TypeError("ATTENDANCE_REPORT_INVALID_RANGE");
  }
  const candidates = payrolls
    .filter((row) => row.periodStart >= startDate && row.periodEnd <= endDate && row.periodStart <= row.periodEnd)
    .sort((a, b) => {
      const daysA = Date.parse(a.periodEnd + "T00:00:00Z") - Date.parse(a.periodStart + "T00:00:00Z");
      const daysB = Date.parse(b.periodEnd + "T00:00:00Z") - Date.parse(b.periodStart + "T00:00:00Z");
      return daysB - daysA || Number(isPaid(b)) - Number(isPaid(a)) || b.id - a.id;
    });

  const selected: AttendanceReportPayrollRecord[] = [];
  for (const candidate of candidates) {
    if (selected.some((row) => candidate.periodStart <= row.periodEnd && candidate.periodEnd >= row.periodStart)) {
      continue;
    }
    selected.push(candidate);
  }
  return selected;
}

function estimateUnpostedSalary(input: AttendanceReportSalaryInput) {
  // Check the runtime types before using date-string methods. API parameters
  // can be arrays or objects even when TypeScript declares them as strings.
  const startDate = input.startDate;
  const endDate = input.endDate;
  if (
    typeof startDate !== "string" ||
    typeof endDate !== "string" ||
    validateAttendanceReportDateRange(startDate, endDate) !== null
  ) {
    throw new TypeError("ATTENDANCE_REPORT_INVALID_RANGE");
  }
  // Factory payroll generation supports these two attendance-based salary
  // types. Bale/KG earnings require production records, not just attendance.
  if (input.salaryType !== "Monthly" && input.salaryType !== "Daily") return zero();

  let result = zero();
  let cursor = startDate;
  while (cursor <= endDate) {
    const [year, month] = cursor.slice(0, 7).split("-").map(Number);
    const calendarDays = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const monthEnd = `${year}-${String(month).padStart(2, "0")}-${String(calendarDays).padStart(2, "0")}`;
    const segmentEnd = monthEnd < endDate ? monthEnd : endDate;
    const statuses = Object.entries(input.attendance)
      .filter(([date]) => date >= cursor && date <= segmentEnd)
      .sort(([dateA], [dateB]) => dateA.localeCompare(dateB))
      .map(([, status]) => (status === "HalfDay" ? "Half Day" : status));
    const calculated = calculateFactoryPayroll({
      salaryType: input.salaryType,
      baseSalary: Number(input.baseSalary || "0"),
      perBaleRate: 0,
      perKgRate: 0,
      overtimeRate: 0,
      startDate: cursor,
      endDate: segmentEnd,
      attendanceStatuses: statuses,
      baleWeightsKg: [],
      outstandingAdvance: 0,
    });
    result = result.plus(money(calculated.netSalary));
    if (input.salaryType === "Monthly") {
      const days =
        Math.round((Date.parse(segmentEnd + "T00:00:00Z") - Date.parse(cursor + "T00:00:00Z")) / 86_400_000) + 1;
      result = result.plus(money(input.transportAllowance).times(days).div(calendarDays));
    }
    const next = new Date(Date.parse(segmentEnd + "T00:00:00Z") + 86_400_000);
    cursor = next.toISOString().slice(0, 10);
  }
  return result.toDecimalPlaces(2);
}

export function reconcileAttendanceReportSalary(input: AttendanceReportSalaryInput): AttendanceReportSalaryResult {
  if (
    typeof input.startDate !== "string" ||
    typeof input.endDate !== "string" ||
    validateAttendanceReportDateRange(input.startDate, input.endDate) !== null
  ) {
    throw new TypeError("ATTENDANCE_REPORT_INVALID_RANGE");
  }
  const selected = selectAttendanceReportPayrolls(input.payrolls, input.startDate, input.endDate);
  if (selected.length === 0) {
    const expected = estimateUnpostedSalary(input);
    return {
      expectedSalary: expected.toFixed(2),
      paidSalary: "0.00",
      remainingSalary: expected.toFixed(2),
      cashPaidSalary: "0.00",
      advancesSettled: "0.00",
      salarySource: "attendance_estimate",
    };
  }

  // A draft or approved payroll is NOT a paid payroll. Its prior cash
  // advances may exist in the advances ledger, but must not inflate the
  // report's Paid Salary KPI. Until payroll is paid, only its net cash due
  // belongs in the expected/remaining settlement calculation.
  const paidRows = selected.filter(isPaid);
  const expected = selected.reduce(
    (total, row) => total.plus(money(row.netSalary)).plus(isPaid(row) ? money(row.advances) : 0),
    zero()
  );
  const cashPaid = paidRows.reduce((total, row) => total.plus(money(row.netSalary)), zero());
  const advancesSettled = paidRows.reduce((total, row) => total.plus(money(row.advances)), zero());
  const paid = cashPaid.plus(advancesSettled);
  return {
    expectedSalary: expected.toFixed(2),
    paidSalary: paid.toFixed(2),
    remainingSalary: expected.minus(paid).toFixed(2),
    cashPaidSalary: cashPaid.toFixed(2),
    advancesSettled: advancesSettled.toFixed(2),
    salarySource: "payroll",
  };
}
