import { describe, expect, it } from "vitest";
import { approx40KgText } from "../client/src/pages/factory/pressing-scanner/pressingKpiFormatting";

describe("Pressing Overview approximate KG ÷ 40 KPIs", () => {
  it("shows precise equivalent bales instead of rounding to nearest ten", () => {
    expect(approx40KgText(3770)).toBe("94.25");
    expect(approx40KgText(3575)).toBe("89.375");
    expect(approx40KgText(1140)).toBe("28.5");
    expect(approx40KgText(8485)).toBe("212.125");
  });

  it("preserves all required decimal places for stored KG precision", () => {
    expect(approx40KgText(40.001)).toBe("1.00003");
    expect(approx40KgText(0)).toBe("0");
    expect(approx40KgText(4000)).toBe("100");
  });
});
