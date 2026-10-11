/**
 * Report totals kept as numbers in response objects (container tracking by
 * agent, location and transporter, order verification, product history) were
 * summed with `+= parseFloat(...)`, so 0.10 + 0.20 came back as
 * 0.30000000000000004. plusMoney adds each step exactly.
 */
import { describe, expect, it } from "vitest";

import { plusMoney } from "../server/lib/money";

describe("plusMoney", () => {
  it("keeps a running total of cent amounts exact", () => {
    let total = 0;
    for (const amount of ["0.10", "0.20", "0.30", "0.40"]) total = plusMoney(total, amount);
    expect(total).toBe(1);
    expect(plusMoney(0.1, "0.2")).toBe(0.3);
  });

  it("matches a float sum's intent over many small amounts", () => {
    let total = 0;
    for (let i = 0; i < 1000; i++) total = plusMoney(total, "0.01");
    expect(total).toBe(10);
  });

  it("treats missing and malformed amounts as zero, like parseFloat(...) || 0 did", () => {
    expect(plusMoney(5, null)).toBe(5);
    expect(plusMoney(5, undefined)).toBe(5);
    expect(plusMoney(5, "")).toBe(5);
    expect(plusMoney(5, "abc")).toBe(5);
  });

  it("adds negative amounts", () => {
    expect(plusMoney(1, "-0.7")).toBe(0.3);
  });
});
