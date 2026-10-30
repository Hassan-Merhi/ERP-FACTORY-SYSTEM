import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  mondayOfProductionBonusWeek,
  parseTypedProductionBonusDate,
} from "../shared/productionTargetBonusWeeklyMethod";

describe("manual weekly production bonus date entry", () => {
  it("accepts typed ISO and US dates, including dates outside Monday", () => {
    expect(parseTypedProductionBonusDate("2026-10-30")).toBe("2026-10-30");
    expect(parseTypedProductionBonusDate("10/30/2026")).toBe("2026-10-30");
    expect(parseTypedProductionBonusDate("2026-2-9")).toBe("2026-02-09");
    expect(parseTypedProductionBonusDate("2/9/2026")).toBe("2026-02-09");
  });

  it("does not replace partial keyboard entry with a different date", () => {
    expect(parseTypedProductionBonusDate("10/")).toBeNull();
    expect(parseTypedProductionBonusDate("2026-10")).toBeNull();
    expect(parseTypedProductionBonusDate("02/30/2026")).toBeNull();
    expect(parseTypedProductionBonusDate("2026-02-30")).toBeNull();
    expect(parseTypedProductionBonusDate("")).toBeNull();
  });

  it("resolves any valid entered day to the correct Monday when saving", () => {
    expect(mondayOfProductionBonusWeek(parseTypedProductionBonusDate("10/30/2026")))
      .toBe("2026-10-26");
    expect(mondayOfProductionBonusWeek(parseTypedProductionBonusDate("10/26/2026")))
      .toBe("2026-10-26");
  });

  it("keeps the manual text field independent of the calendar selection", () => {
    const source = readFileSync(resolve(process.cwd(),
      "client/src/pages/factory/productiontargets/ProductionBonusWeeklyMethodPanel.tsx"), "utf8");
    expect(source).toContain('aria-label="Type bonus week date"');
    expect(source).toContain('aria-label="Choose bonus week date from calendar"');
    expect(source).toContain("onChange={event => setEffectiveWeek(event.target.value)}");
    expect(source).not.toContain('setEffectiveWeek(mondayOfProductionBonusWeek(event.target.value) ?? "")');
  });
});
