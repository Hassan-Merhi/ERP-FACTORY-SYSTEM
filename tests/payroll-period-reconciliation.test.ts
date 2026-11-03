import { describe, expect, it } from "vitest";
import {
  reconcilePeriodPayrolls,
  type PayrollReconciliationRecord,
} from "../server/services/payroll/periodPayrollReconciliation";
import {
  assertNoOverlappingPayroll,
  PayrollPeriodOverlapError,
} from "../server/services/payroll/payrollPeriodOverlapPolicy";

function paid(overrides: Partial<PayrollReconciliationRecord> = {}): PayrollReconciliationRecord {
  return {
    id: 1,
    workerId: 10,
    workerActive: true,
    periodStart: "2026-10-01",
    periodEnd: "2026-10-31",
    status: "PAID",
    netSalary: "600.00",
    advances: "400.00",
    hasDaybookPayment: true,
    ...overrides,
  };
}

describe("backend payroll period reconciliation", () => {
  it("never counts draft payroll as paid cash, even with prior advance deductions", () => {
    const result = reconcilePeriodPayrolls(
      [paid({ id: 1 }), paid({ id: 2, workerId: 11, status: "DRAFT", netSalary: "76.26", advances: "506.00", hasDaybookPayment: false })],
      "2026-10-01",
      "2026-10-31"
    );
    expect(result.draftUnpaidTotal).toBe("582.26");
    expect(result.cashPaidNetTotal).toBe("600.00");
    expect(result.canonicalPaidTotal).toBe("1000.00");
    expect(result.allPayrollRecordTotal).toBe("1582.26");
    expect(result.draftCount).toBe(1);
  });

  it("preserves paid former workers and separately flags overlapping paid records", () => {
    const result = reconcilePeriodPayrolls(
      [
        paid({ id: 1, workerId: 10, netSalary: "26476.66", advances: "18594.00" }),
        paid({ id: 2, workerId: 10, periodEnd: "2026-10-17", netSalary: "155.81", advances: "280.00" }),
        paid({ id: 3, workerId: 30, workerActive: false, periodEnd: "2026-10-14", netSalary: "894.22", advances: "200.00" }),
        paid({ id: 4, workerId: 31, workerActive: false, status: "DRAFT", periodEnd: "2026-10-17", netSalary: "76.26", advances: "506.00", hasDaybookPayment: false }),
      ],
      "2026-10-01",
      "2026-10-31"
    );
    expect(result).toMatchObject({
      canonicalActivePaid: "45070.66",
      canonicalFormerWorkerPaid: "1094.22",
      canonicalPaidTotal: "46164.88",
      overlappingPaidTotal: "435.81",
      overlappingPaidAdvanceDeductions: "280.00",
      draftUnpaidTotal: "582.26",
      allPayrollRecordTotal: "47182.95",
      cashPaidNetTotal: "27526.69",
      canonicalPaidCount: 2,
      overlappingPaidCount: 1,
      formerWorkerPaidCount: 1,
      draftCount: 1,
      missingPaymentEvidenceCount: 0,
      requiresAccountingReview: true,
    });
  });

  it("adds distinct non-overlapping paid intervals for one worker", () => {
    const result = reconcilePeriodPayrolls([
      paid({ id: 1, periodStart: "2026-10-01", periodEnd: "2026-10-07", netSalary: "90.00", advances: "10.00" }),
      paid({ id: 2, periodStart: "2026-10-08", periodEnd: "2026-10-14", netSalary: "80.00", advances: "20.00" }),
    ], "2026-10-01", "2026-10-31");
    expect(result.canonicalPaidTotal).toBe("200.00");
    expect(result.overlappingPaidTotal).toBe("0.00");
  });

  it("flags missing paid Daybook evidence without automatically changing cash balances", () => {
    const result = reconcilePeriodPayrolls(
      [paid({ hasDaybookPayment: false })], "2026-10-01", "2026-10-31"
    );
    expect(result.missingPaymentEvidenceCount).toBe(1);
    expect(result.requiresAccountingReview).toBe(true);
  });

  it("ignores payroll periods extending outside the selected window", () => {
    const result = reconcilePeriodPayrolls(
      [paid({ periodStart: "2026-09-01", periodEnd: "2026-10-31" })],
      "2026-10-01", "2026-10-31"
    );
    expect(result.canonicalPaidTotal).toBe("0.00");
  });
});

describe("overlapping payroll generation protection", () => {
  it("rejects overlapping PAID payrolls before advancing or posting", () => {
    expect(() => assertNoOverlappingPayroll([
      { id: 12, workerId: 10, periodStart: "2026-10-01", periodEnd: "2026-10-17", status: "PAID" },
    ], [10], "2026-10-01", "2026-10-31")).toThrow(PayrollPeriodOverlapError);
  });

  it("rejects DRAFT overlaps too, so unfinished payrolls cannot double-accrue", () => {
    expect(() => assertNoOverlappingPayroll([
      { id: 12, workerId: 10, periodStart: "2026-10-01", periodEnd: "2026-10-17", status: "DRAFT" },
    ], [10], "2026-10-17", "2026-10-31")).toThrow(PayrollPeriodOverlapError);
  });

  it("allows adjacent, non-overlapping dates and other workers", () => {
    expect(() => assertNoOverlappingPayroll([
      { id: 12, workerId: 10, periodStart: "2026-10-01", periodEnd: "2026-10-17", status: "PAID" },
    ], [10], "2026-10-18", "2026-10-31")).not.toThrow();
    expect(() => assertNoOverlappingPayroll([
      { id: 12, workerId: 20, periodStart: "2026-10-01", periodEnd: "2026-10-17", status: "PAID" },
    ], [10], "2026-10-01", "2026-10-31")).not.toThrow();
  });
});
