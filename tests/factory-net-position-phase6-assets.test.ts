/**
 * Phase 6 acceptance tests for factory historical asset/liability projections.
 * Saved for Claude's later run; never run by this implementation stage.
 */
import { describe, expect, it } from "vitest";
import {
  remainingAdvanceAt,
  replayWorkerAdvances,
  sumRentalContractPositions,
} from "../server/services/factory/netPositionHistoricalAssets";

describe("Factory Net Position Phase 6 historical worker advances", () => {
  it("replays the original advance and only the repayments selected by the caller's date cutoff", () => {
    // The query selects advances and repayments with BOTH their effective
    // dates and recorded_at <= asOf. A $30 repayment on Oct 21 cannot
    // change October 19's remaining $100.
    expect(remainingAdvanceAt("100", [])).toBe(100);
    expect(remainingAdvanceAt("100", ["20"])).toBe(80);
    expect(remainingAdvanceAt("100", ["20", "30"])).toBe(50);
  });

  it("never creates a negative asset when repayments exceed principal", () => {
    expect(remainingAdvanceAt("100", ["80", "25"])).toBe(0);
  });

  it("uses decimal money rather than binary float or current remaining_balance", () => {
    expect(remainingAdvanceAt("0.30", ["0.10", "0.10"])).toBe(0.1);
  });
});

describe("Factory Net Position Phase 6 historical rent", () => {
  it("preserves the existing per-contract absolute receivable/credit formula", () => {
    expect(
      sumRentalContractPositions([
        { expected: "200", paid: "150" },
        { expected: "100", paid: "120" },
      ])
    ).toBe(70);
  });

  it("does not offset balances of different tenants before summing", () => {
    expect(
      sumRentalContractPositions([
        { expected: "100.00", paid: "0" },
        { expected: "0", paid: "100.00" },
      ])
    ).toBe(200);
  });

  it("uses decimal cents for full and partial rent payments", () => {
    expect(
      sumRentalContractPositions([
        { expected: "0.30", paid: "0.10" },
        { expected: "0.20", paid: "0.10" },
      ])
    ).toBe(0.3);
  });
});

describe("historical worker advances — payroll deductions without repayment rows", () => {
  const advance = (id: number, amount: string, advanceDate: string, repaymentType = "salary_deduction") => ({
    id,
    workerId: 9,
    amount,
    advanceDate,
    repaymentType,
  });

  it("applies a payroll's advance deduction oldest-first, as settleAdvancesForPayroll does", () => {
    const advances = [advance(2, "60", "2026-10-10"), advance(1, "40", "2026-10-01")];
    expect(replayWorkerAdvances(advances, new Map(), new Map([[9, "50"]]))).toBe(50);
    expect(replayWorkerAdvances(advances, new Map(), new Map())).toBe(100);
  });

  it("never takes a deduction below zero and keeps linked repayments", () => {
    const advances = [advance(1, "40", "2026-10-01")];
    expect(replayWorkerAdvances(advances, new Map([[1, ["10"]]]), new Map([[9, "100"]]))).toBe(0);
    expect(replayWorkerAdvances(advances, new Map([[1, ["10"]]]), new Map())).toBe(30);
  });

  it("settles salary-deduction advances before manual-repayment ones", () => {
    const advances = [advance(1, "40", "2026-10-01", "manual_repayment"), advance(2, "40", "2026-10-05")];
    expect(replayWorkerAdvances(advances, new Map(), new Map([[9, "40"]]))).toBe(40);
  });
});
