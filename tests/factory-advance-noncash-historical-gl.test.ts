import { describe, expect, it } from "vitest";
import {
  advanceLedgerBalance,
  validateNonCashHistoricalGLRepair,
} from "../server/startup/runApprovedFactoryWorkerAdvanceNonCashGLRepair";

const before = {
  advanced: "91538.29",
  outstanding: "2675.00",
  payroll: "88690.29",
  repaid: "173.00",
  advances: { opening: "299.99", dr: "91201.90", cr: "88775.28" },
  cash: { opening: "0.00", dr: "2948914.65", cr: "2872074.07" },
  payable: { opening: "0.00", dr: "204704.13", cr: "319906.09" },
  equity: { opening: "0.00", dr: "0.00", cr: "0.00" },
};

const after = {
  ...before,
  advances: { ...before.advances, cr: "88826.89" },
  payable: { ...before.payable, dr: "204704.14" },
  equity: { ...before.equity, dr: "51.60" },
};

describe("source-proven dated worker advance GL reconciliation", () => {
  it("reconciles ledger and worker receivables exactly without touching cash", () => {
    expect(advanceLedgerBalance(before)).toBe("2726.61");
    expect(advanceLedgerBalance(after)).toBe("2675.00");
    expect(() => validateNonCashHistoricalGLRepair(before,after)).not.toThrow();
  });
  it("never accepts changes to Cash, including one cent", () => {
    expect(() => validateNonCashHistoricalGLRepair(before, {
      ...after,cash:{...after.cash,cr:"2872074.08"},
    })).toThrow("CASH_CHANGED");
  });
  it("does not allow advance source or paid payroll changes", () => {
    expect(() => validateNonCashHistoricalGLRepair(before, {
      ...after,payroll:"88690.30",
    })).toThrow("WORKER_OR_PAYROLL_CHANGED");
  });
  it("requires exactly one cent for the May 17 paid advance recovery", () => {
    expect(() => validateNonCashHistoricalGLRepair(before, {
      ...after,payable:{...after.payable,dr:"204704.15"},
    })).toThrow("PAYROLL_PAYABLE_POSTCHECK");
  });
  it("requires exactly $51.60 to historical opening balance equity", () => {
    expect(() => validateNonCashHistoricalGLRepair(before, {
      ...after,equity:{...after.equity,dr:"51.61"},
    })).toThrow("EQUITY_POSTCHECK");
  });
  it("does not silently change the original $299.99 opening balance", () => {
    expect(() => validateNonCashHistoricalGLRepair(before, {
      ...after,advances:{...after.advances,opening:"248.38"},
    })).toThrow("ADVANCES_POSTCHECK");
  });
  it("rejects pre-existing balance movement on opening balance equity", () => {
    expect(() => validateNonCashHistoricalGLRepair({
      ...before,equity:{...before.equity,cr:"1.00"},
    },after)).toThrow("OPENING_EQUITY_NOT_EMPTY");
  });
  it("rejects unsupported worker liability balances", () => {
    expect(() => validateNonCashHistoricalGLRepair({
      ...before,outstanding:"2675.01",
    },after)).toThrow("SOURCE_TOTALS_CHANGED");
  });
});
