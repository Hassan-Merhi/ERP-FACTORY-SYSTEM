/**
 * Net profit totals and payroll proration were summed and rounded in binary
 * floats: Math.round(1.005 * 100) / 100 is 1, and 0.3 - 0.1 is
 * 0.19999999999999998. minusMoney / roundCents work on the decimal values.
 */
import { describe, expect, it } from "vitest";

import { minusMoney, plusMoney, roundCents } from "../server/lib/money";
import { computeMonthlyPay } from "../server/routes/payroll/worker-statement/_helpers";

describe("minusMoney", () => {
  it("subtracts cent amounts exactly", () => {
    expect(minusMoney(0.3, 0.1)).toBe(0.2);
    expect(minusMoney(plusMoney(0.1, 0.2), "0.3")).toBe(0);
    expect(minusMoney(5, null)).toBe(5);
  });
});

describe("roundCents", () => {
  it("rounds half a cent up instead of down", () => {
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents("2.675")).toBe(2.68);
    expect(roundCents(1.004)).toBe(1);
  });
});

describe("computeMonthlyPay", () => {
  it("prorates by calendar days without float residue", () => {
    // 10 of 31 days in January plus all of February.
    expect(computeMonthlyPay(3100, "2026-01-22", "2026-02-28")).toBe(4100);
    expect(computeMonthlyPay(0.3, "2026-02-01", "2026-02-28")).toBe(0.3);
  });
});
