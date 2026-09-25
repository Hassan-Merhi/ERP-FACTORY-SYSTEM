/**
 * Daily production report: product classification and money formatting.
 *
 * The classifiers turn free-text category names typed by staff into the buckets
 * the report's charts are built from, using patterns for grades, crème and the
 * one supplier name that is deliberately excluded. They are the report: if a
 * pattern stops matching, production silently moves into "Other" and the charts
 * keep drawing as if nothing happened.
 */
import { describe, expect, it } from "vitest";
import {
  classifyByGrade,
  classifyCategory,
  classifyDetailed,
  computeWorkerExpectedSalary,
  daysInCalendarMonth,
  fmtKg,
  fmtL,
  fmtML,
  fmtMoney,
  fmtNL,
  fmtRate,
  fmtSalary,
  groupByCategory,
} from "./utils";

describe("category classification", () => {
  it("recognises the main product families", () => {
    expect(classifyCategory("SUMMER 1")).toBe("Summer");
    expect(classifyCategory("winter creme")).toBe("Winter");
    expect(classifyCategory("Ladies Bags")).toBe("Bags");
    expect(classifyCategory("SHOES 2")).toBe("Shoes");
    expect(classifyCategory("Toys 3")).toBe("Toys");
  });

  it("puts an unrecognised name in Other rather than dropping it", () => {
    expect(classifyCategory("Miscellaneous")).toBe("Other");
  });

  it("excludes the one supplier the report deliberately leaves out", () => {
    expect(classifyCategory("ABO SAMAR MIXED")).toBe("__skip__");
    expect(classifyCategory("abosamar")).toBe("__skip__");
  });
});

describe("detailed classification", () => {
  it("splits a family into its grades", () => {
    expect(classifyDetailed("SUMMER 1")).toBe("Summer 1");
    expect(classifyDetailed("SUMMER 4")).toBe("Summer 4");
    expect(classifyDetailed("BAGS 2")).toBe("Bags 2");
  });

  it("recognises crème by any of the spellings staff use", () => {
    expect(classifyDetailed("SUMMER CREME")).toBe("Summer Crème");
    expect(classifyDetailed("Summer Crème")).toBe("Summer Crème");
    expect(classifyDetailed("Summer big size")).toBe("Summer Crème");
  });

  it("defaults a family with no grade to its first grade", () => {
    expect(classifyDetailed("WINTER")).toBe("Winter 1");
  });

  it("keeps wipers and garbage apart in the detailed view", () => {
    // "GARBAGE" contains "BAG", so a bags-first test charted every garbage line
    // as a bag while the by-grade chart called the same line Wipers & Garbage.
    expect(classifyDetailed("WIPERS 2")).toBe("Wipers 2");
    expect(classifyDetailed("GARBAGE RAGS 3")).toBe("Garbage 3");
  });

  it("agrees with the by-grade chart about what a line is", () => {
    for (const name of ["GARBAGE 1", "WIPERS 2", "RAGS 3"]) {
      expect(classifyCategory(name)).toBe("Wipers & Garbage");
      expect(classifyByGrade(name)).toBe("Wipers & Garbage");
      expect(classifyDetailed(name).startsWith("Bags")).toBe(false);
    }
  });
});

describe("grade classification", () => {
  it("merges the seasonal families into shared grade numbers", () => {
    expect(classifyByGrade("SUMMER 1")).toBe("Grade #1");
    expect(classifyByGrade("WINTER 1")).toBe("Grade #1");
    expect(classifyByGrade("Summer Crème")).toBe("Grade Crème");
  });

  it("keeps the non-graded families as their own buckets", () => {
    expect(classifyByGrade("BAGS 2")).toBe("Bags");
    expect(classifyByGrade("TOYS 3")).toBe("Toys");
    expect(classifyByGrade("SHOES 4")).toBe("Shoes");
    expect(classifyByGrade("WIPERS 1")).toBe("Wipers & Garbage");
    expect(classifyByGrade("GARBAGE 1")).toBe("Wipers & Garbage");
  });

  it("accepts the merged wipers-and-garbage marker the chart passes in", () => {
    expect(classifyByGrade("__WIPERS_GARBAGE__")).toBe("Wipers & Garbage");
  });
});

describe("money and weight formatting", () => {
  it("drops the decimals on a round amount and keeps them otherwise", () => {
    expect(fmtMoney(1200)).toBe("$1,200");
    expect(fmtMoney(1200.5)).toBe("$1,200.50");
    expect(fmtMoney(0)).toBe("$0");
  });

  it("shows nothing rather than NaN for a missing amount", () => {
    expect(fmtMoney(null)).toBe("$0");
    expect(fmtMoney(undefined)).toBe("$0");
    expect(fmtRate(null)).toBe("$0.000");
    expect(fmtKg(null)).toBe("0 kg");
  });

  it("shows a rate per kilo with at most four decimals", () => {
    // Backend precision stays untouched; this helper is display-only.
    expect(fmtRate(0.6421298359)).toBe("$0.6421");
    expect(fmtRate(1.23456)).toBe("$1.2346");
    expect(fmtRate(1.2)).toBe("$1.200");
  });

  it("keeps one decimal on a weight", () => {
    expect(fmtKg(1234.56)).toBe("1,234.6 kg");
  });

  it("formats a salary with cents", () => {
    expect(fmtSalary(1200)).toBe("1,200.00");
  });

  it("formats large numbers with separators", () => {
    expect(fmtL(1234.56)).toBe("1,234.6");
    expect(fmtNL(1234)).toBe("1,234");
    expect(fmtML(1234)).toBe("$1,234");
    expect(fmtML(1234.5)).toBe("$1,234.50");
    expect(fmtML(0)).toBe("$0");
  });
});

describe("expected salary", () => {
  it("counts the days in the month the date belongs to", () => {
    expect(daysInCalendarMonth("2026-02-15")).toBe(28);
    expect(daysInCalendarMonth("2028-02-15")).toBe(29);
    expect(daysInCalendarMonth("2026-03-15")).toBe(31);
  });

  it("earns a full day for a day present and half for a half day", () => {
    const worker = {
      baseSalary: "310",
      salaryType: "Monthly",
      transportAllowance: "0",
      attendance: { "2026-03-01": "Present", "2026-03-02": "HalfDay" },
    };

    const earned = computeWorkerExpectedSalary(worker, [
      { date: "2026-03-01", isWeekend: false },
      { date: "2026-03-02", isWeekend: false },
    ]);

    // 310 over a 31-day month is 10 a day.
    expect(earned).toBeCloseTo(15, 6);
  });

  it("earns nothing for a day absent", () => {
    const worker = {
      baseSalary: "310",
      salaryType: "Monthly",
      transportAllowance: "0",
      attendance: { "2026-03-01": "Absent" },
    };

    expect(computeWorkerExpectedSalary(worker, [{ date: "2026-03-01", isWeekend: false }])).toBe(0);
  });

  it("pays weekends and approved leave", () => {
    const worker = {
      baseSalary: "310",
      salaryType: "Monthly",
      transportAllowance: "0",
      attendance: { "2026-03-02": "Leave" },
    };

    const earned = computeWorkerExpectedSalary(worker, [
      { date: "2026-03-01", isWeekend: true },
      { date: "2026-03-02", isWeekend: false },
    ]);

    expect(earned).toBeCloseTo(20, 6);
  });

  it("adds the transport allowance as a flat monthly benefit", () => {
    const worker = {
      baseSalary: "310",
      salaryType: "Monthly",
      transportAllowance: "50",
      attendance: { "2026-03-01": "Present" },
    };

    // Not prorated: a worker present for one day still receives the month's
    // transport, which is what the payroll pays.
    expect(computeWorkerExpectedSalary(worker, [{ date: "2026-03-01", isWeekend: false }])).toBeCloseTo(60, 6);
  });

  it("computes nothing for a worker who is not on a monthly salary", () => {
    const worker = {
      baseSalary: "310",
      salaryType: "Daily",
      transportAllowance: "50",
      attendance: { "2026-03-01": "Present" },
    };

    expect(computeWorkerExpectedSalary(worker, [{ date: "2026-03-01", isWeekend: false }])).toBe(0);
  });
});

describe("grouping", () => {
  it("groups rows by their category, keeping first-seen order", () => {
    const grouped = groupByCategory([
      { categoryName: "Summer" },
      { categoryName: "Winter" },
      { categoryName: "Summer" },
    ] as never);

    expect(grouped.map((entry) => entry.category)).toEqual(["Summer", "Winter"]);
    expect(grouped[0].items).toHaveLength(2);
  });

  it("gives rows with no category a visible placeholder", () => {
    const grouped = groupByCategory([{ categoryName: null }] as never);

    expect(grouped[0].category).toBe("—");
  });
});
