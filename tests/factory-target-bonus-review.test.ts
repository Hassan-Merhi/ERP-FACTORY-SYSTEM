import { describe, expect, it } from "vitest";
import { allocateLinkedBales, targetBonusIsValidDate, targetBonusValidRange } from "../server/services/factory/targetBonusReview";

describe("Production Targets bonus review validation", () => {
  it("splits 14 linked bales as 7 + 7, and 15 as 8 + 7 with no fractions", () => {
    expect(allocateLinkedBales(14, [22, 11], 11)).toBe(7);
    expect(allocateLinkedBales(14, [22, 11], 22)).toBe(7);
    expect(allocateLinkedBales(15, [22, 11], 11)).toBe(8);
    expect(allocateLinkedBales(15, [22, 11], 22)).toBe(7);
    expect(allocateLinkedBales(3, [11, 22, 33], 33)).toBe(1);
    expect(() => allocateLinkedBales(4, [11, 22], 33)).toThrow();
  });

  it("accepts only genuine ISO production dates", () => {
    expect(targetBonusIsValidDate("2026-10-30")).toBe(true);
    expect(targetBonusIsValidDate("2026-02-29")).toBe(false);
    expect(targetBonusIsValidDate("2024-02-29")).toBe(true);
    expect(targetBonusIsValidDate("2026-9-1")).toBe(false);
    expect(targetBonusIsValidDate("2026-13-01")).toBe(false);
  });

  it("rejects reversed or unbounded review ranges", () => {
    expect(targetBonusValidRange("2026-10-01", "2026-10-30")).toBe(true);
    expect(targetBonusValidRange("2026-10-01", "2026-11-01")).toBe(true);
    expect(targetBonusValidRange("2026-10-01", "2026-11-02")).toBe(false);
    expect(targetBonusValidRange("2026-10-30", "2026-10-29")).toBe(false);
    expect(targetBonusValidRange("", "2026-10-30")).toBe(false);
  });
});
