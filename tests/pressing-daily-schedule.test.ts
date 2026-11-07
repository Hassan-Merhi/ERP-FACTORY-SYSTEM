import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  PRESSING_DAILY_HOURS, PRESSING_WORKDAYS, pressingDailyScheduleForDay,
  pressingWeeklyScheduleForDay, pressingWeeklyScheduleForWeekday, pressingWeekdayFromDate,
} from "../server/routes/factory/pressingDailySchedule";

const allHours = (kg: number) =>
  Object.fromEntries(PRESSING_DAILY_HOURS.map(hour => [String(hour), kg]));

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
      hours: allHours(800), effectiveDay: "2026-11-07",
    });
    expect(pressingDailyScheduleForDay(legacy, "2026-11-11")).toEqual({
      hours: allHours(950), effectiveDay: "2026-11-11",
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
      hours: allHours(950), effectiveDay: "2026-11-10",
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
      "2026-11-11": { "1": { ...allHours(950), "11": 0 } },
    };
    expect(pressingWeeklyScheduleForDay(weekly, {}, "2026-11-16")).toEqual({
      hours: allHours(900), effectiveDay: "2026-11-07",
    });
    expect(pressingWeeklyScheduleForWeekday(weekly, {}, "2026-11-16", 0).hours).toEqual({});
    expect(pressingWeeklyScheduleForWeekday(weekly, {}, "2026-11-16", 7).hours).toEqual({});
  });

  it("requires supervisor writes, saves each weekday atomically, and keeps date overrides", () => {
    const api = readFileSync("server/routes/factory/factoryPressingReportRoutes.ts", "utf8");
    const ui = readFileSync("client/src/pages/factory/PressingHourlyTargets.tsx", "utf8");
    expect(api).toContain('"/api/factory/pressing-machines/report/hourly-targets/daily-schedule"');
    expect(api).toContain("pressingHourlyWeeklySchedulesKg");
    expect(api).toContain("pressingWeeklyScheduleForDay");
    expect(api).toContain("if (!ctx.canCorrect)");
    expect(api).toContain("weekday: z.number().int().min(1).max(6)");
    expect(api).toContain("jsonb_build_object($3::text,$4::jsonb)");
    expect(api).toContain("const hourlyTargetsKg: Record<string, number> = { ...dailySchedule.hours }");
    expect(api).toContain("pressingHourlyTargetsByDateKg");
    expect(ui).toContain("SCHEDULE_DAYS");
    expect(ui).toContain("Save ");
    expect(ui).toContain("selectedWeekday");
    expect(ui).toContain('ENDPOINT + "/daily-schedule"');
    expect(ui).toContain("weekday: selectedWeekday, targetsKg");
    expect(ui).toContain("Sunday · off");
  });
});
