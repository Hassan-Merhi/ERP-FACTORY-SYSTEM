import { describe, expect, it } from "vitest";
import { validateNoCashAdvanceRepair } from "../server/startup/runApprovedNoCashAdvanceSourceRepair";

const before = {
  originals: "91589.90",
  workerOutstanding: "2515.00",
  payrollRecovered: "88690.29",
  repaid: "173.00",
  ledgerOpening: "299.99",
  ledgerDebit: "91201.90",
  ledgerCredit: "88775.28",
  ledgerBalance: "2726.61",
  cashOpening: "0.00",
  cashDebit: "2948914.65",
  cashCredit: "2872074.07",
};
const expectedAfter = {
  ...before,
  originals: "91538.29",
  workerOutstanding: "2675.00",
};

describe("worker advances source repair - cash never changes", () => {
  it("accepts exact recovered worker balances with identical Cash and vouchers", () => {
    expect(() => validateNoCashAdvanceRepair(before, expectedAfter)).not.toThrow();
  });
  it("blocks changes to Cash, even a one-cent difference", () => {
    expect(() => validateNoCashAdvanceRepair(before, {
      ...expectedAfter,cashCredit:"2872074.08",
    })).toThrow("CASH_LEDGER_CHANGED");
  });
  it("blocks a Cash opening balance change", () => {
    expect(() => validateNoCashAdvanceRepair(before, {
      ...expectedAfter,cashOpening:"0.01",
    })).toThrow("CASH_LEDGER_CHANGED");
  });
  it("blocks changing the advances ledger to force a match", () => {
    expect(() => validateNoCashAdvanceRepair(before, {
      ...expectedAfter,ledgerBalance:"2675.00",
    })).toThrow("ACCOUNTING_LEDGER_CHANGED");
  });
  it("blocks changes to historical manual repayments and paid payroll", () => {
    expect(() => validateNoCashAdvanceRepair(before, {
      ...expectedAfter,repaid:"173.01",
    })).toThrow("PAYROLL_OR_REPAYMENTS_CHANGED");
  });
  it("blocks unverified starting worker receivables", () => {
    expect(() => validateNoCashAdvanceRepair({
      ...before,workerOutstanding:"2515.01",
    }, expectedAfter)).toThrow("ORIGINAL_SOURCES_CHANGED");
  });
  it("blocks an incomplete correction to worker balances", () => {
    expect(() => validateNoCashAdvanceRepair(before, {
      ...expectedAfter,workerOutstanding:"2515.00",
    })).toThrow("WORKER_BALANCES_NOT_REPAIRED");
  });
});
