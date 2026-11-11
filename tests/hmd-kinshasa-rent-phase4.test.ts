import { describe, expect, it } from "vitest";
import {
  isValidRentalBusinessDate,
  operationalRentOutstanding,
  shouldSettleAccruedRentPayable,
} from "../server/services/rental/rentalPaymentClassification";

describe("Phase 4 permanent rental posting classification", () => {
  const accrued = {
    dueOnPaymentDate: true,
    accrualVoucherLive: true,
    creditedAccruedPayable: true,
    recognitionHold: false,
  };

  it("settles a live, credited rent payable, not an arbitrary monthly stamp", () => {
    expect(shouldSettleAccruedRentPayable(accrued)).toBe(true);
    expect(shouldSettleAccruedRentPayable({ ...accrued, creditedAccruedPayable: false })).toBe(false);
    expect(shouldSettleAccruedRentPayable({ ...accrued, accrualVoucherLive: false })).toBe(false);
    expect(shouldSettleAccruedRentPayable({ ...accrued, recognitionHold: true })).toBe(false);
    expect(shouldSettleAccruedRentPayable({ ...accrued, dueOnPaymentDate: false })).toBe(false);
  });

  it("rejects rollover, malformed or impossible billing/payment dates", () => {
    expect(isValidRentalBusinessDate("2026-11-10")).toBe(true);
    expect(isValidRentalBusinessDate("2028-02-29")).toBe(true);
    expect(isValidRentalBusinessDate("2026-02-29")).toBe(false);
    expect(isValidRentalBusinessDate("2026-02-30")).toBe(false);
    expect(isValidRentalBusinessDate("2026-13-01")).toBe(false);
    expect(isValidRentalBusinessDate("2026-6-01")).toBe(false);
    expect(isValidRentalBusinessDate("2026-11-10T12:00:00Z")).toBe(false);
  });

  it("never nets prepaid overpayments against an unrelated month's debt", () => {
    expect(operationalRentOutstanding("500", "200")).toBe(300);
    expect(operationalRentOutstanding("500", "500")).toBe(0);
    expect(operationalRentOutstanding("500", "800")).toBe(0);
    expect(operationalRentOutstanding("66.60", "20.25")).toBe(46.35);
    expect(() => operationalRentOutstanding("NaN", "20")).toThrow("RENTAL_OUTSTANDING_NONFINITE_AMOUNT");
  });
});
