import { describe, expect, it } from "vitest";
import { toMoney } from "../server/lib/money";

describe("MODA ZAKARIA broker settlement sign and color parity", () => {
  it("preserves the USD pool penny in the current equivalent", () => {
    const eurPayable = toMoney("27932.85");
    const usdPool = toMoney("-0.01");
    const usdRate = toMoney("1.18");
    expect(eurPayable.times(usdRate).toFixed(3)).toBe("32960.763");
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(3)).toBe("32960.753");
    expect(eurPayable.times(usdRate).plus(usdPool).toFixed(2)).toBe("32960.75");
  });
});
