/**
 * toMoney reads a leading number the way parseFloat does, so spreadsheet and
 * form values such as "25 kg" or "12.50 USD" keep their amount.
 */
import { describe, expect, it } from "vitest";

import { toMoney } from "../server/lib/money";

describe("toMoney leading-number input", () => {
  it("reads the leading number like parseFloat", () => {
    expect(toMoney("25 kg").toNumber()).toBe(25);
    expect(toMoney("12.50 USD").toFixed(2)).toBe("12.50");
    expect(toMoney("-1foo").toNumber()).toBe(-1);
    expect(toMoney(" 3.5").toNumber()).toBe(3.5);
  });

  it("still treats text without a number as zero", () => {
    expect(toMoney("abc").toNumber()).toBe(0);
    expect(toMoney("USD 12").toNumber()).toBe(0);
    expect(toMoney("1,234.50").toNumber()).toBe(1);
  });
});
