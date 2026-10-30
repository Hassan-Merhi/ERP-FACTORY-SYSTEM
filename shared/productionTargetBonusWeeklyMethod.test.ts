import { describe, expect, it } from "vitest";
import {
  isProductionWorkday, mondayOfProductionBonusWeek, parseWeeklyFlatBonusUsd,
  resolveProductionBonusWeeklyMethod,
  type ProductionBonusWeeklyMethodVersion,
} from "./productionTargetBonusWeeklyMethod";

const versions: ProductionBonusWeeklyMethodVersion[] = [
  { id: 1, effectiveWeek: "2026-10-19", method: "per_extra_bale", flatBonusUsd: "0.00" },
  { id: 2, effectiveWeek: "2026-10-26", method: "weekly_flat", flatBonusUsd: "15.00" },
  { id: 3, effectiveWeek: "2026-10-26", method: "weekly_flat", flatBonusUsd: "20.00" },
  { id: 4, effectiveWeek: "2026-11-02", method: "per_extra_bale", flatBonusUsd: "0.00" },
];

describe("Phase 12 weekly Production Targets bonus method configuration", () => {
  it("treats every Sunday as a non-counted production holiday", () => {
    expect(isProductionWorkday("2026-10-26")).toBe(true);
    expect(isProductionWorkday("2026-10-31")).toBe(true);
    expect(isProductionWorkday("2026-11-01")).toBe(false);
    expect(isProductionWorkday("2026-11-02")).toBe(true);
    expect(isProductionWorkday("bad-date")).toBe(false);
  });

  it("defines Monday through Sunday without local browser time zone shifts", () => {
    expect(mondayOfProductionBonusWeek("2026-10-26")).toBe("2026-10-26");
    expect(mondayOfProductionBonusWeek("2026-10-30")).toBe("2026-10-26");
    expect(mondayOfProductionBonusWeek("2026-11-01")).toBe("2026-10-26");
    expect(mondayOfProductionBonusWeek("2026-11-02")).toBe("2026-11-02");
    expect(mondayOfProductionBonusWeek("2026-02-30")).toBeNull();
    expect(mondayOfProductionBonusWeek("bad-date")).toBeNull();
  });

  it("validates USD cents precisely, with no float or scientific notation", () => {
    expect(parseWeeklyFlatBonusUsd("15")).toBe("15.00");
    expect(parseWeeklyFlatBonusUsd("15.5")).toBe("15.50");
    expect(parseWeeklyFlatBonusUsd("15.50")).toBe("15.50");
    expect(parseWeeklyFlatBonusUsd("0.01")).toBe("0.01");
    expect(parseWeeklyFlatBonusUsd("100000.00")).toBe("100000.00");
    for (const invalid of ["-1", "100000.01", "15.001", "1e2", "", "01", " 20", null, {}, "Infinity"]) {
      expect(parseWeeklyFlatBonusUsd(invalid)).toBeNull();
    }
  });

  it("resolves latest dated mode for a whole week, with highest same-week ID winning", () => {
    expect(resolveProductionBonusWeeklyMethod("2026-10-18", versions)).toBeNull();
    expect(resolveProductionBonusWeeklyMethod("2026-10-25", versions)?.method).toBe("per_extra_bale");
    expect(resolveProductionBonusWeeklyMethod("2026-10-26", versions)?.id).toBe(3);
    expect(resolveProductionBonusWeeklyMethod("2026-10-30", versions)?.flatBonusUsd).toBe("20.00");
    expect(resolveProductionBonusWeeklyMethod("2026-11-01", versions)?.id).toBe(3);
    expect(resolveProductionBonusWeeklyMethod("2026-11-02", versions)?.method).toBe("per_extra_bale");
  });

  it("does not conflate extra-bale rates with fixed weekly fee versions", () => {
    const weekly = resolveProductionBonusWeeklyMethod("2026-10-30", versions);
    expect(weekly).toMatchObject({ method: "weekly_flat", flatBonusUsd: "20.00" });
    expect(weekly).not.toHaveProperty("ratePerExtraBale");
    expect(weekly).not.toHaveProperty("paymentVoucherId");
    expect(weekly).not.toHaveProperty("reviewId");
  });
});
