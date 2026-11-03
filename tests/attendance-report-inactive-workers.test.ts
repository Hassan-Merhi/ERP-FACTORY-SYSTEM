import { describe, expect, it } from "vitest";
import { reconcileAttendanceReportSalary } from "../server/services/payroll/attendanceReportSalary";
import type { AttendanceReportPayrollRecord } from "../server/services/payroll/attendanceReportSalary";

const startDate = "2026-10-01";
const endDate = "2026-10-31";

function salary(record: AttendanceReportPayrollRecord) {
  return reconcileAttendanceReportSalary({
    startDate,
    endDate,
    salaryType: "Monthly",
    baseSalary: "0",
    transportAllowance: "0",
    attendance: {},
    payrolls: [record],
  });
}

function payroll(
  id: number,
  workerId: number,
  status: string,
  netSalary: string,
  advances = "0.00",
  periodEnd = "2026-10-17"
): AttendanceReportPayrollRecord {
  return {
    id,
    workerId,
    status,
    netSalary,
    advances,
    periodStart: startDate,
    periodEnd,
  };
}

describe("October 2026 inactive-worker attendance report reconciliation", () => {
  it("includes former workers' genuine paid salary without marking their drafts as paid", () => {
    const active = salary(payroll(1500, 10, "PAID", "26476.66", "18594.00", endDate));
    const inactivePaid = [
      payroll(1175, 229, "PAID", "136.78"),
      payroll(1176, 250, "PAID", "102.58"),
      payroll(1177, 234, "PAID", "136.78"),
      payroll(1178, 254, "PAID", "136.78"),
      payroll(1179, 255, "PAID", "136.78"),
      payroll(1181, 257, "PAID", "136.78"),
      payroll(1186, 231, "PAID", "22.26", "200.00"),
      payroll(1187, 258, "PAID", "85.48"),
    ].map(salary);
    const inactiveDrafts = [
      payroll(1174, 249, "DRAFT", "34.19", "0.00"),
      payroll(1182, 48, "DRAFT", "33.07", "250.00"),
      payroll(1184, 205, "DRAFT", "9.00", "256.00"),
    ].map(salary);

    const cents = (value: string) => Math.round(Number(value) * 100);
    const sum = (values: string[]) => values.reduce((total, value) => total + cents(value), 0);
    expect(inactivePaid).toHaveLength(8);
    expect(inactiveDrafts).toHaveLength(3);
    expect(sum(inactivePaid.map((row) => row.paidSalary))).toBe(109422);
    expect(sum(inactiveDrafts.map((row) => row.paidSalary))).toBe(0);
    expect(sum(inactiveDrafts.map((row) => row.remainingSalary))).toBe(7626);

    const all = [active, ...inactivePaid, ...inactiveDrafts];
    expect(sum(all.map((row) => row.paidSalary))).toBe(4616488);
    expect(sum(all.map((row) => row.expectedSalary))).toBe(4624114);
    expect(sum(all.map((row) => row.remainingSalary))).toBe(7626);
    // This does not include extra overlapping paid periods or unpaid draft accruals
    // in paid salary just to force a match with Analytics expense.
    expect(4718295 - sum(all.map((row) => row.paidSalary))).toBe(101807);
  });

  it("keeps partial paid former-worker payroll as payable once, and drafts unpaid", () => {
    const result = salary(payroll(1186, 231, "PAID", "22.26", "200.00"));
    expect(result).toMatchObject({
      expectedSalary: "222.26",
      paidSalary: "222.26",
      remainingSalary: "0.00",
      cashPaidSalary: "22.26",
      advancesSettled: "200.00",
    });
    const draft = salary(payroll(1182, 48, "DRAFT", "33.07", "250.00"));
    expect(draft).toMatchObject({
      expectedSalary: "33.07",
      paidSalary: "0.00",
      remainingSalary: "33.07",
      advancesSettled: "0.00",
    });
  });
});
