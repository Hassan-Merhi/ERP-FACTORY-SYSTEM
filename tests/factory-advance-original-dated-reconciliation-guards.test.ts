import { describe, expect, it } from "vitest";
import { validateHistoricalAdvanceTotals } from "../server/startup/runApprovedFactoryWorkerAdvanceHistoricalCleanup";

const original = {
  original: "91589.90",
  remaining: "2515.00",
  payroll: "88690.29",
  manual: "173.00",
  opening: "299.99",
  debit: "91201.90",
  credit: "88775.28",
  ledger: "2726.61",
  cash: "50000.00",
  payable: "10000.00",
};

const repaired = {
  original: "91538.29",
  remaining: "2675.00",
  payroll: "88690.29",
  manual: "173.00",
  opening: "0.00",
  debit: "91538.29",
  credit: "88863.29",
  ledger: "2675.00",
  cash: "49751.61",
  payable: "9999.99",
};

describe("factory advance original-dated repair guards", () => {
  it("reconciles the original advance, paid payroll, and cash facts exactly", () => {
    expect(() => validateHistoricalAdvanceTotals(original, repaired)).not.toThrow();
  });

  it("refuses to claim completion when the ledger is still off by one cent", () => {
    expect(() =>
      validateHistoricalAdvanceTotals(original, { ...repaired, ledger: "2675.01" })
    ).toThrow("LEDGER_POSTCHECK");
  });

  it("rejects unexpected changes to the original worker advances", () => {
    expect(() =>
      validateHistoricalAdvanceTotals({ ...original, original: "91590.90" }, repaired)
    ).toThrow("ADVANCE_SOURCE_CHANGED");
  });

  it("never changes past payroll deductions or repayment records", () => {
    expect(() =>
      validateHistoricalAdvanceTotals(original, { ...repaired, manual: "174.00" })
    ).toThrow("RECOVERY_CHANGED");
  });

  it("requires the documented original-date cash corrections only", () => {
    expect(() =>
      validateHistoricalAdvanceTotals(original, { ...repaired, cash: "50000.00" })
    ).toThrow("CASH_POSTCHECK");
  });

  it("requires a balanced one-cent payroll payable correction", () => {
    expect(() =>
      validateHistoricalAdvanceTotals(original, { ...repaired, payable: "10000.00" })
    ).toThrow("PAYABLE_POSTCHECK");
  });
});
