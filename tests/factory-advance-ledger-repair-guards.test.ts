import { describe, expect, it } from "vitest";
import { classifyApprovedAccrualSnapshot } from "../server/startup/runApprovedFactoryWorkerAdvanceLedgerRepair";

const august = {
  start: "2026-08-01",
  end: "2026-08-31",
  workers: 91,
  expected: "13240.00",
  net: "27559.92",
  bonuses: "0.00",
  paymentVouchers: 91,
  before: "0.00",
  vouchers: 0,
} as const;

const september = {
  start: "2026-09-01",
  end: "2026-09-30",
  workers: 92,
  expected: "18051.00",
  net: "26157.47",
  bonuses: "0.00",
  paymentVouchers: 92,
  before: "17851.00",
  vouchers: 1,
} as const;

const augustSnapshot = {
  workers: 91,
  paidWorkers: 91,
  net: "27559.92",
  bonuses: "0.00",
  paymentVouchers: 91,
  payableDebits: "27559.92",
  expected: "13240.00",
  posted: "0.00",
  vouchers: 0,
} as const;

const septemberSnapshot = {
  workers: 92,
  paidWorkers: 92,
  net: "26157.47",
  bonuses: "0.00",
  paymentVouchers: 92,
  payableDebits: "26157.47",
  expected: "18051.00",
  posted: "17851.00",
  vouchers: 1,
} as const;

describe("backend-only worker advance accrual repair preconditions", () => {
  it("marks a verified, missing August accrual as pending", () => {
    expect(classifyApprovedAccrualSnapshot(august, augustSnapshot)).toBe("pending");
  });

  it("skips a completed reconciliation instead of double-posting", () => {
    expect(
      classifyApprovedAccrualSnapshot(august, {
        ...augustSnapshot,
        posted: "13240.00",
        vouchers: 1,
      })
    ).toBe("done");
  });

  it("rebuilds a historically incomplete September voucher once", () => {
    expect(classifyApprovedAccrualSnapshot(september, septemberSnapshot)).toBe("pending");
  });

  it("rejects a changed payroll source amount", () => {
    expect(() =>
      classifyApprovedAccrualSnapshot(august, {
        ...augustSnapshot,
        expected: "13240.01",
      })
    ).toThrow("PAYROLL_SOURCE_CHANGED");
  });

  it("refuses accruals without verified matching salary-payment vouchers", () => {
    expect(() =>
      classifyApprovedAccrualSnapshot(august, {
        ...augustSnapshot,
        paymentVouchers: 90,
      })
    ).toThrow("PAYROLL_SOURCE_CHANGED");
  });

  it("rejects a duplicated or foreign historical accrual", () => {
    expect(() =>
      classifyApprovedAccrualSnapshot(august, {
        ...augustSnapshot,
        posted: "13240.00",
        vouchers: 2,
      })
    ).toThrow("UNEXPECTED_POSTED_STATE");
  });
});
