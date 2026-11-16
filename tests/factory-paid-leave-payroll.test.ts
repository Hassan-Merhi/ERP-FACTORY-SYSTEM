import { describe, expect, it } from "vitest";
import { MoneyDecimal } from "../server/lib/money";
import {
  computeWorkerPayAmounts,
  exactMonthlyPayFromAttendance,
  presentDaysOf,
} from "../server/routes/payroll/core/workerPayAmounts";

describe("factory payroll paid leave", () => {
  it("pays Leave at one full monthly daily rate", () => {
    const salary = new MoneyDecimal(3100);
    const attendance = [
      { status: "Present" },
      { status: "Leave" },
      { status: "Late" },
      { status: "Half Day" },
      { status: "Absent" },
    ];
    expect(exactMonthlyPayFromAttendance(salary, "2026-11-01", attendance).toFixed(2)).toBe("350.00");
    expect(presentDaysOf(attendance)).toBe(3.5);
  });

  it("includes paid leave in the preview/generation shared pay calculation without paying absences", () => {
    const pay = computeWorkerPayAmounts({
      worker: { baseSalary: "3000", payFrequency: "Monthly", transportAllowance: "300" },
      days: 30,
      periodStart: "2026-11-01",
      periodEnd: "2026-11-30",
      attendance: [{ status: "Present" }, { status: "Leave" }, { status: "Absent" }],
      bonus: new MoneyDecimal(0),
      transportOverride: null,
      advanceBalance: new MoneyDecimal(0),
      advanceOverride: null,
      pendingDeductions: new MoneyDecimal(0),
    });
    expect(pay.base.toFixed(2)).toBe("200.00");
    expect(pay.transport.toFixed(2)).toBe("20.00");
    expect(pay.presentDays).toBe(2);
    expect(pay.net.toFixed(2)).toBe("220.00");
  });

  it("does not pay unmarked or absent days when attendance exists", () => {
    expect(
      exactMonthlyPayFromAttendance(new MoneyDecimal(3000), "2026-11-01", [
        { status: "Absent" },
        { status: null },
      ]).toFixed(2)
    ).toBe("0.00");
  });
});
