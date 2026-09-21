import { describe, expect, it } from "vitest";

import {
  buildAutomaticComparisonRanges,
  isValidComparisonRange,
  isValidLocalIsoDate,
  rangeForMonth,
  shiftDay,
  shiftMonth,
  shiftYear,
} from "../../client/src/pages/factory/productcomparison/utils";

describe("Factory product comparison date ranges", () => {
  it("defaults a monthly previous comparison to the complete adjacent month", () => {
    expect(
      buildAutomaticComparisonRanges("month", "previous", {
        day: "2026-09-21",
        month: "2026-09",
        year: "2026",
      })
    ).toEqual({
      selected: { from: "2026-09-01", to: "2026-09-30" },
      comparison: { from: "2026-08-01", to: "2026-08-31" },
    });
  });

  it("moves a next-month comparison across a year boundary", () => {
    expect(shiftMonth("2026-12", "next")).toBe("2027-01");
    expect(rangeForMonth("2027-01")).toEqual({ from: "2027-01-01", to: "2027-01-31" });
  });

  it("handles leap-day adjacent daily comparisons", () => {
    expect(shiftDay("2028-02-28", "next")).toBe("2028-02-29");
    expect(shiftDay("2028-03-01", "previous")).toBe("2028-02-29");
  });

  it("moves yearly comparisons in either direction", () => {
    expect(shiftYear("2026", "previous")).toBe("2025");
    expect(shiftYear("2026", "next")).toBe("2027");
  });

  it("builds next-day ranges without widening the selected day", () => {
    expect(
      buildAutomaticComparisonRanges("day", "next", {
        day: "2026-09-21",
        month: "2026-09",
        year: "2026",
      })
    ).toEqual({
      selected: { from: "2026-09-21", to: "2026-09-21" },
      comparison: { from: "2026-09-22", to: "2026-09-22" },
    });
  });

  it("rejects blank or impossible custom dates before they can be formatted or queried", () => {
    expect(isValidLocalIsoDate("")).toBe(false);
    expect(isValidLocalIsoDate("2026-02-29")).toBe(false);
    expect(isValidLocalIsoDate("2028-02-29")).toBe(true);
  });

  it("rejects reversed custom comparison ranges", () => {
    expect(isValidComparisonRange({ from: "2026-09-21", to: "2026-09-20" })).toBe(false);
    expect(isValidComparisonRange({ from: "2026-09-20", to: "2026-09-21" })).toBe(true);
  });
});
