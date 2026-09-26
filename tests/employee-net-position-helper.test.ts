import { describe, expect, it } from "vitest";

import {
  computeEmployeeNetPosition,
  computeEmployeeNetPositionWithManagedAdvances,
} from "../server/helpers/employeeNetPosition";

describe("computeEmployeeNetPosition", () => {
  it("keeps employee receivables and payables on separate sides", () => {
    const result = computeEmployeeNetPosition(
      [
        { id: 1, openingBalance: "0", openingBalanceSide: "Cr" },
        { id: 2, openingBalance: "0", openingBalanceSide: "Cr" },
        { id: 3, openingBalance: "0", openingBalanceSide: "Cr" },
      ],
      new Map([
        [1, { debit: 200, credit: 0 }],
        [2, { debit: 0, credit: 75 }],
        [3, { debit: 50, credit: 0 }],
      ])
    );

    expect(result.advances).toBe(250);
    expect(result.liabilities).toBe(75);
  });

  it("honors debit and credit opening-balance sides", () => {
    const result = computeEmployeeNetPosition(
      [
        { id: 10, openingBalance: "125.50", openingBalanceSide: "Dr" },
        { id: 11, openingBalance: "40.25", openingBalanceSide: "Cr" },
      ],
      new Map()
    );

    expect(result.advances).toBe(125.5);
    expect(result.liabilities).toBe(40.25);
  });

  it("nets movements within an employee before classifying the side", () => {
    const result = computeEmployeeNetPosition(
      [{ id: 20, openingBalance: "100", openingBalanceSide: "Dr" }],
      new Map([[20, { debit: 25, credit: 60 }]])
    );

    expect(result.advances).toBe(65);
    expect(result.liabilities).toBe(0);
  });

  it("replaces managed advance voucher debits with the remaining balance", () => {
    const employees = [{ id: 30, openingBalance: "0", openingBalanceSide: "Cr" }];
    const balances = new Map([[30, { debit: 700, credit: 0 }]]);

    const result = computeEmployeeNetPositionWithManagedAdvances(
      employees,
      balances,
      [{ employeeId: 30, postedDebit: 500, remainingBalance: 300 }]
    );

    // $700 debit = $500 managed advance + $200 direct withdrawal.
    // Replace the managed $500 original debit with its $300 remaining balance.
    expect(result.advances).toBe(500);
    expect(result.liabilities).toBe(0);
  });

  it("removes a fully repaid managed advance but keeps unrelated employee debits", () => {
    const employees = [{ id: 31, openingBalance: "0", openingBalanceSide: "Cr" }];
    const balances = new Map([[31, { debit: 650, credit: 0 }]]);

    const result = computeEmployeeNetPositionWithManagedAdvances(
      employees,
      balances,
      [{ employeeId: 31, postedDebit: 500, remainingBalance: 0 }]
    );

    expect(result.advances).toBe(150);
    expect(result.liabilities).toBe(0);
  });
});
