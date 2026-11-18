import { describe, expect, it } from "vitest";
import { toEmployeeAdvanceRow } from "./EmployeeAdvancesCard";

describe("toEmployeeAdvanceRow", () => {
  it("maps the snake_case rows the advances endpoint returns", () => {
    expect(
      toEmployeeAdvanceRow({
        id: 7,
        advance_date: "2026-11-02",
        amount: "150.00",
        remaining_balance: "40.00",
        fully_paid: false,
        notes: null,
      })
    ).toEqual({
      id: 7,
      advanceDate: "2026-11-02",
      amount: "150.00",
      remainingBalance: "40.00",
      fullyPaid: false,
      notes: null,
    });
  });

  it("keeps camelCase rows as they are and reads a repaid advance as paid", () => {
    expect(
      toEmployeeAdvanceRow({ id: 8, advanceDate: "2026-10-01", amount: "20", remainingBalance: "0", fullyPaid: true })
    ).toMatchObject({ advanceDate: "2026-10-01", remainingBalance: "0", fullyPaid: true, notes: null });
  });
});
