import { describe, expect, it } from "vitest";
import { approx40KgText } from "../client/src/pages/factory/pressing-scanner/pressingKpiFormatting";

describe("Pressing Overview approximate KG ÷ 40 KPIs", () => {
  it("rounds KG / 40 to the nearest whole number, never nearest ten", () => {
    expect(approx40KgText(3770)).toBe("94");   // 94.25 -> 94
    expect(approx40KgText(3575)).toBe("89");   // 89.375 -> 89
    expect(approx40KgText(1140)).toBe("29");   // 28.5 -> 29
    expect(approx40KgText(8485)).toBe("212"); // 212.125 -> 212
  });

  it("rounds exact halves up", () => {
    expect(approx40KgText(8500)).toBe("213"); // 212.5 -> 213
    expect(approx40KgText(3780)).toBe("95");  // 94.5 -> 95
    expect(approx40KgText(3760)).toBe("94");  // 94 exactly
  });

  it("leaves tiny values at zero and keeps thousands grouping", () => {
    expect(approx40KgText(0)).toBe("0");
    expect(approx40KgText(40.001)).toBe("1");
    expect(approx40KgText(4000)).toBe("100");
    expect(approx40KgText(40000)).toBe("1,000");
  });
});
