import { describe, expect, it } from "vitest";
import {
  isBonusCategoryDate, normalizeBonusCategory, parseBonusCategoryRate,
  resolveBonusCategoryRate, type ProductionBonusCategoryRateVersion,
} from "../shared/productionTargetBonusCategoryRates";

const versions: ProductionBonusCategoryRateVersion[] = [
  { id: 1, categoryKey: "bags", categoryLabel: "Bags",
    effectiveFrom: "2026-10-01", enabled: true, ratePerExtraBale: "0.2500" },
  { id: 2, categoryKey: "toys", categoryLabel: "Toys",
    effectiveFrom: "2026-10-01", enabled: true, ratePerExtraBale: "0.6000" },
  { id: 3, categoryKey: "bags", categoryLabel: "Bags",
    effectiveFrom: "2026-11-01", enabled: true, ratePerExtraBale: "0.5000" },
  { id: 4, categoryKey: "bags", categoryLabel: "Bags",
    effectiveFrom: "2026-11-01", enabled: false, ratePerExtraBale: "0.5000" },
];

describe("Phase 8 category-rate configuration", () => {
  it("normalizes case, spaces and unicode without combining distinct product categories", () => {
    expect(normalizeBonusCategory("  BAGS  ")).toEqual({ key: "bags", label: "BAGS" });
    expect(normalizeBonusCategory("RAGS  &   TOYS")?.key).toBe("rags & toys");
    expect(normalizeBonusCategory("Garbage")?.key).not.toBe("bags");
    expect(normalizeBonusCategory("  ")).toBeNull();
    expect(normalizeBonusCategory("x".repeat(101))).toBeNull();
    expect(normalizeBonusCategory("Bags\nOther")).toEqual({ key: "bags other", label: "Bags Other" });
  });
  it("requires real effective dates", () => {
    expect(isBonusCategoryDate("2026-02-29")).toBe(false);
    expect(isBonusCategoryDate("2028-02-29")).toBe(true);
    expect(isBonusCategoryDate("2026-10-30")).toBe(true);
    expect(isBonusCategoryDate("2026-11-31")).toBe(false);
  });
  it("accepts exact USD 4dp and rejects unsafe or negative money", () => {
    expect(parseBonusCategoryRate("0.3333")).toBe("0.3333");
    expect(parseBonusCategoryRate("0")).toBe("0.0000");
    expect(parseBonusCategoryRate("10000")).toBe("10000.0000");
    for (const value of ["-1", "1.12345", "10000.01", "1e3", "NaN", " 1 ", ""]) {
      expect(parseBonusCategoryRate(value)).toBeNull();
    }
  });
  it("resolves category history without bleeding a different rate into the worker day", () => {
    expect(resolveBonusCategoryRate(" Bags ", "2026-10-30", versions)?.id).toBe(1);
    expect(resolveBonusCategoryRate("Toys", "2026-10-30", versions)?.id).toBe(2);
    expect(resolveBonusCategoryRate("Shoes", "2026-10-30", versions)).toBeNull();
    expect(resolveBonusCategoryRate("BAGS", "2026-11-04", versions)?.id).toBe(4);
    expect(resolveBonusCategoryRate("Bags", "2026-09-01", versions)).toBeNull();
    expect(resolveBonusCategoryRate("Bags", "invalid", versions)).toBeNull();
  });
});
