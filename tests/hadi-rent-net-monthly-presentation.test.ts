import { describe, expect, it } from "vitest";
import {
  netExpenseMovement,
  sumPresentedMonthlyMovements,
} from "../client/src/lib/monthlyRentExpensePresentation";

const source2026 = [
  { month: "January", debit: 103600, credit: 70900, expectedNetDr: 32700 },
  { month: "February", debit: 37950, credit: 3500, expectedNetDr: 34450 },
  { month: "March", debit: 34450, credit: 0, expectedNetDr: 34450 },
  { month: "April", debit: 37950, credit: 0, expectedNetDr: 37950 },
  { month: "May", debit: 40950, credit: 0, expectedNetDr: 40950 },
  { month: "June", debit: 487000, credit: 446050, expectedNetDr: 40950 },
  { month: "July", debit: 41650, credit: 400, expectedNetDr: 41250 },
  { month: "August", debit: 43250, credit: 0, expectedNetDr: 43250 },
  { month: "September", debit: 43250, credit: 0, expectedNetDr: 43250 },
  { month: "October", debit: 48200, credit: 2000, expectedNetDr: 46200 },
  { month: "November", debit: 38950, credit: 0, expectedNetDr: 38950 },
];

describe("HADI 2026 monthly Rent Expense net debit presentation", () => {
  it.each(source2026)(
    "$month: displays reconciled rent on Dr only, not the gross correcting credits",
    ({ debit, credit, expectedNetDr }) => {
      expect(netExpenseMovement({ debit, credit })).toEqual({
        debit: expectedNetDr,
        credit: 0,
      });
    }
  );

  it("shows exactly $434,350 Dr and zero credit for January–November", () => {
    const displayed = source2026.map(netExpenseMovement);
    expect(sumPresentedMonthlyMovements(displayed)).toEqual({
      debit: 434350,
      credit: 0,
    });
  });

  it("leaves the original posted debit and credit values untouched", () => {
    const original = Object.freeze({ debit: 487000, credit: 446050 });
    const shown = netExpenseMovement(original);
    expect(shown).toEqual({ debit: 40950, credit: 0 });
    expect(original).toEqual({ debit: 487000, credit: 446050 });
  });

  it("preserves a genuine credit month as a net Cr instead of hiding it", () => {
    expect(netExpenseMovement({ debit: 1500, credit: 3200 })).toEqual({
      debit: 0,
      credit: 1700,
    });
  });

  it("cancels balanced monthly corrections and avoids floating-cent artifacts", () => {
    expect(netExpenseMovement({ debit: 1000.1, credit: 1000.1 })).toEqual({
      debit: 0,
      credit: 0,
    });
    expect(netExpenseMovement({ debit: 2000.05, credit: 25.03 })).toEqual({
      debit: 1975.02,
      credit: 0,
    });
  });
});
