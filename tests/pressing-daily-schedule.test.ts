import { describe, expect, it } from "vitest";
import {
  PRESSING_DAILY_HOURS,
  PRESSING_WORKDAYS,
  pressingDailyScheduleForDay,
  pressingWeeklyScheduleForDay,
  pressingWeeklyScheduleForWeekday,
  pressingWeekdayFromDate,
} from "../server/routes/factory/pressingDailySchedule";
import {
  PRESSING_MAX_TARGET_KG,
  canEditPressingTargets,
  mergePressingHourlyTargets,
  pressingHourTargetOverride,
  pressingScheduleHours,
  pressingTargetKgSchema,
  pressingWeeklyScheduleInputSchema,
} from "../server/routes/factory/pressingHourlyTargetRules";

const allHours = (kg: number) => Object.fromEntries(PRESSING_DAILY_HOURS.map((hour) => [String(hour), kg]));

describe("Pressing Monday–Saturday recurring KG schedules", () => {
  it("covers exactly ten Beirut hourly slots and excludes Sunday", () => {
    expect(PRESSING_DAILY_HOURS).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(PRESSING_WORKDAYS).toEqual([1, 2, 3, 4, 5, 6]);
    expect(pressingWeekdayFromDate("2026-11-07")).toBe(6); // Saturday
    expect(pressingWeekdayFromDate("2026-11-08")).toBe(0); // Sunday
    expect(pressingWeekdayFromDate("2026-11-09")).toBe(1); // Monday
  });

  it("preserves earlier all-day templates and date-specific history", () => {
    const legacy = {
      "2026-11-07": allHours(800),
      "2026-11-11": allHours(950),
    };
    expect(pressingDailyScheduleForDay(legacy, "2026-11-06").hours).toEqual({});
    expect(pressingDailyScheduleForDay(legacy, "2026-11-09")).toEqual({
      hours: allHours(800),
      effectiveDay: "2026-11-07",
    });
    expect(pressingDailyScheduleForDay(legacy, "2026-11-11")).toEqual({
      hours: allHours(950),
      effectiveDay: "2026-11-11",
    });
  });

  it("resolves independent weekday targets, and excludes Sundays after weekly mode begins", () => {
    const legacy = { "2026-11-01": allHours(800) };
    const weekly = {
      "2026-11-07": { "1": allHours(900), "6": allHours(750) },
      "2026-11-10": { "1": allHours(950) },
    };
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-01").hours).toEqual(allHours(800));
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-09").hours).toEqual(allHours(900));
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-16")).toEqual({
      hours: allHours(950),
      effectiveDay: "2026-11-10",
    });
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-14").hours).toEqual(allHours(750));
    // Unsaved weekdays retain previously configured recurring targets.
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-12").hours).toEqual(allHours(800));
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-08").hours).toEqual({});
    expect(pressingWeeklyScheduleForWeekday(weekly, legacy, "2026-11-07", 5).hours).toEqual(allHours(800));
  });

  it("rejects incomplete versions without overriding earlier valid weekday targets", () => {
    const weekly = {
      "2026-11-07": { "1": allHours(900) },
      "2026-11-11": { "1": { ...allHours(950), "11": -1 } },
    };
    expect(pressingWeeklyScheduleForDay(weekly, {}, "2026-11-16")).toEqual({
      hours: allHours(900),
      effectiveDay: "2026-11-07",
    });
    expect(pressingWeeklyScheduleForWeekday(weekly, {}, "2026-11-16", 0).hours).toEqual({});
    expect(pressingWeeklyScheduleForWeekday(weekly, {}, "2026-11-16", 7).hours).toEqual({});
  });

  it("accepts zero per-hour values and does not replace them with defaults", () => {
    const zeroHour = { ...allHours(800), "11": 0, "14": 0 };
    const legacy = { "2026-11-07": zeroHour };
    const weekly = { "2026-11-09": { "1": zeroHour } };
    expect(pressingDailyScheduleForDay(legacy, "2026-11-08").hours).toEqual(zeroHour);
    expect(pressingWeeklyScheduleForDay(weekly, legacy, "2026-11-16")).toEqual({
      hours: zeroHour,
      effectiveDay: "2026-11-09",
    });
    expect(pressingWeeklyScheduleForDay({ "2026-11-09": { "1": allHours(0) } }, {}, "2026-11-16").hours).toEqual(
      allHours(0)
    );
    // Missing values are not silently treated as explicit zero.
    expect(pressingDailyScheduleForDay({ "2026-11-07": { ...zeroHour, "11": null } }, "2026-11-08").hours).toEqual({});
    expect(
      pressingWeeklyScheduleForDay({ "2026-11-09": { "1": { ...zeroHour, "14": "" } } }, {}, "2026-11-16").hours
    ).toEqual({});
  });

  it("validates zero targets in both route types and treats them as no required target", () => {
    const tenHours = (kg: number) => PRESSING_DAILY_HOURS.map(() => kg);
    expect(pressingTargetKgSchema.safeParse(0).success).toBe(true);
    expect(pressingTargetKgSchema.safeParse(PRESSING_MAX_TARGET_KG).success).toBe(true);
    expect(pressingTargetKgSchema.safeParse(-0.5).success).toBe(false);
    expect(pressingTargetKgSchema.safeParse(PRESSING_MAX_TARGET_KG + 1).success).toBe(false);
    expect(pressingTargetKgSchema.safeParse(Number.NaN).success).toBe(false);
    expect(pressingWeeklyScheduleInputSchema.safeParse({ weekday: 1, targetsKg: tenHours(0) }).success).toBe(true);
    // A date override of 0 KG wins over the recurring schedule; missing values do not.
    expect(mergePressingHourlyTargets(allHours(800), { "11": 0, "12": null, "13": "", "14": -3 })).toEqual({
      ...allHours(800),
      "11": 0,
    });
    expect(pressingHourTargetOverride(undefined)).toBeNull();
    expect(pressingHourTargetOverride("0")).toBe(0);
    // How a 0 KG hour is shown ("No target", no percentage) is rendered in
    // tests/ui/pressing-hourly-targets-schedule.test.tsx.
  });

  it("requires supervisor writes and accepts only Monday–Saturday weekly schedules with ten hours", () => {
    expect(canEditPressingTargets("Admin", false)).toBe(true);
    expect(canEditPressingTargets("Owner", false)).toBe(true);
    for (const role of ["Manager", "Developer", "View Only", "Create Only", "POS", "Normal User", "User"]) {
      expect(canEditPressingTargets(role, false), role).toBe(false);
    }
    expect(canEditPressingTargets("Owner", true)).toBe(false);
    const tenHours = PRESSING_DAILY_HOURS.map(() => 900);
    expect(pressingWeeklyScheduleInputSchema.safeParse({ weekday: 6, targetsKg: tenHours }).success).toBe(true);
    for (const weekday of [0, 7, 1.5]) {
      expect(
        pressingWeeklyScheduleInputSchema.safeParse({ weekday, targetsKg: tenHours }).success,
        String(weekday)
      ).toBe(false);
    }
    expect(pressingWeeklyScheduleInputSchema.safeParse({ weekday: 1, targetsKg: tenHours.slice(1) }).success).toBe(
      false
    );
    expect(pressingWeeklyScheduleInputSchema.safeParse({ weekday: 1, targetsKg: tenHours, companyId: 9 }).success).toBe(
      false
    );
    expect(pressingScheduleHours(tenHours)).toEqual(allHours(900));
  });
});
