import { describe, expect, it } from "vitest";
import {
  assertDirectBonusPayable,
  validateBonusPaymentPostingRequest,
} from "../server/services/payroll/productionTargetBonusPaymentService";

const valid = {
  companyId: 12, allocationId: 123, cashAccountId: 456,
  paymentDate: "2026-10-29", currency: "USD",
  actorId: "admin", actorName: "Admin",
};
const eligible = {
  decisionStatus: "APPROVED", finished: true,
  payrollId: null, extraBales: 4, amount: "6.00",
};

describe("production bonus separate payment accounting (phases 5/6)", () => {
  it("requires an exact date, valid account and USD without guessed FX", () => {
    expect(() => validateBonusPaymentPostingRequest(valid)).not.toThrow();
    expect(() => validateBonusPaymentPostingRequest({ ...valid, cashAccountId: 0 })).toThrow(/account/i);
    expect(() => validateBonusPaymentPostingRequest({ ...valid, paymentDate: "2026-02-30" })).toThrow(/date/i);
    expect(() => validateBonusPaymentPostingRequest({ ...valid, currency: "CFA" })).toThrow(/verified FX/i);
  });
  it("requires End Production, approval and a positive extra-bale award", () => {
    expect(() => assertDirectBonusPayable(eligible, false)).not.toThrow();
    expect(() => assertDirectBonusPayable({ ...eligible, finished: false }, false)).toThrow(/End Production/i);
    expect(() => assertDirectBonusPayable({ ...eligible, decisionStatus: "PENDING" }, false)).toThrow(/approved/i);
    expect(() => assertDirectBonusPayable({ ...eligible, extraBales: 0 }, false)).toThrow(/extra-bale/i);
    expect(() => assertDirectBonusPayable({ ...eligible, amount: "0" }, false)).toThrow(/extra-bale/i);
  });
  it("blocks salary payroll claims and direct payment duplicates even after reversal", () => {
    expect(() => assertDirectBonusPayable({ ...eligible, payrollId: 17 }, false)).toThrow(/payroll/i);
    expect(() => assertDirectBonusPayable(eligible, true)).toThrow(/duplicate payment/i);
    expect(() => assertDirectBonusPayable(eligible, true)).toThrow(/reversed/i);
  });
});
