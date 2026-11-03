import { describe, expect, it } from "vitest";
import {
  reconcileAttendanceReportSalary,
  selectAttendanceReportPayrolls,
  type AttendanceReportPayrollRecord,
} from "../server/services/payroll/attendanceReportSalary";

function payroll(overrides: Partial<AttendanceReportPayrollRecord>): AttendanceReportPayrollRecord {
  return {
    id: 1,
    workerId: 10,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    status: "PAID",
    netSalary: "600.00",
    advances: "400.00",
    ...overrides,
  };
}

function salary(payrolls: AttendanceReportPayrollRecord[], overrides: Record<string, unknown> = {}) {
  return reconcileAttendanceReportSalary({
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    salaryType: "Monthly",
    baseSalary: "1000.00",
    transportAllowance: "80.00",
    attendance: {},
    payrolls,
    ...overrides,
  });
}

describe("attendance report payroll reconciliation", () => {
  it("matches October fully paid payroll and advance settlement, not net cash alone", () => {
    const row = payroll({
      netSalary: "26476.66",
      advances: "18594.00",
    });
    const result = salary([row]);
    expect(result).toMatchObject({
      expectedSalary: "45070.66",
      paidSalary: "45070.66",
      remainingSalary: "0.00",
      cashPaidSalary: "26476.66",
      advancesSettled: "18594.00",
      salarySource: "payroll",
    });
  });

  it("does not double count earlier overlapping payroll when the full month was finalized", () => {
    const rows = [
      payroll({ id: 101, netSalary: "600.00", advances: "400.00" }),
      payroll({
        id: 102,
        periodEnd: "2026-10-17",
        netSalary: "155.81",
        advances: "0.00",
      }),
    ];
    expect(selectAttendanceReportPayrolls(rows, "2026-10-01", "2026-10-31")).toHaveLength(1);
    expect(salary(rows)).toMatchObject({
      expectedSalary: "1000.00",
      paidSalary: "1000.00",
      remainingSalary: "0.00",
      cashPaidSalary: "600.00",
    });
  });

  it("never calls a DRAFT or APPROVED payroll paid, including its advance deductions", () => {
    expect(salary([payroll({ status: "APPROVED", netSalary: "600.00" })])).toMatchObject({
      expectedSalary: "600.00",
      paidSalary: "0.00",
      cashPaidSalary: "0.00",
      advancesSettled: "0.00",
      remainingSalary: "600.00",
    });
    expect(salary([payroll({ status: "DRAFT", netSalary: "76.26", advances: "506.00" })])).toMatchObject({
      expectedSalary: "76.26",
      paidSalary: "0.00",
      remainingSalary: "76.26",
      advancesSettled: "0.00",
      cashPaidSalary: "0.00",
    });
  });

  it("sums distinct nonoverlapping weekly payrolls and calculates remaining exactly", () => {
    const rows = [
      payroll({
        id: 1,
        periodStart: "2026-10-01",
        periodEnd: "2026-10-07",
        netSalary: "199.99",
        advances: "80.01",
        status: "PAID",
      }),
      payroll({
        id: 2,
        periodStart: "2026-10-08",
        periodEnd: "2026-10-14",
        netSalary: "120.09",
        advances: "30.00",
        status: "APPROVED",
      }),
    ];
    expect(salary(rows)).toMatchObject({
      expectedSalary: "430.09",
      paidSalary: "310.00",
      remainingSalary: "120.09",
      cashPaidSalary: "199.99",
      advancesSettled: "110.01",
    });
  });

  it("does not count an unrelated cross-period monthly payroll as paid in a partial window", () => {
    const rows = [payroll({ periodStart: "2026-09-01", periodEnd: "2026-10-31" })];
    expect(selectAttendanceReportPayrolls(rows, "2026-10-01", "2026-10-31")).toEqual([]);
    expect(salary(rows).salarySource).toBe("attendance_estimate");
  });

  it("uses the canonical Half Day value for estimates without any payroll record", () => {
    const result = salary([], {
      baseSalary: "3100.00",
      transportAllowance: "80.00",
      attendance: {
        "2026-10-01": "Present",
        "2026-10-02": "Half Day",
        "2026-10-03": "Absent",
      },
    });
    expect(result).toMatchObject({
      expectedSalary: "230.00",
      paidSalary: "0.00",
      remainingSalary: "230.00",
      salarySource: "attendance_estimate",
    });
  });

  it("keeps per-bale estimate at zero when production data and finalized payroll are absent", () => {
    const result = salary([], { salaryType: "Per Bale", baseSalary: "100.00" });
    expect(result.expectedSalary).toBe("0.00");
    expect(result.remainingSalary).toBe("0.00");
  });

  it("does not mistake an advance-only fully settled payroll for unpaid salary", () => {
    expect(salary([payroll({ netSalary: "0.00", advances: "350.00" })])).toMatchObject({
      expectedSalary: "350.00",
      paidSalary: "350.00",
      remainingSalary: "0.00",
      cashPaidSalary: "0.00",
      advancesSettled: "350.00",
    });
  });
});
