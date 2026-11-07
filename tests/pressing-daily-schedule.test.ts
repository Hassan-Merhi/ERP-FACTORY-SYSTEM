import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PRESSING_DAILY_HOURS, pressingDailyScheduleForDay } from "../server/routes/factory/pressingDailySchedule";

const allHours = (kg: number) => Object.fromEntries(PRESSING_DAILY_HOURS.map(hour => [String(hour), kg]));

describe("Pressing recurring daily hour targets", () => {
  it("covers exactly ten Beirut production hours", () => {
    expect(PRESSING_DAILY_HOURS).toEqual([7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  });

  it("keeps history stable when the recurring schedule changes", () => {
    const schedules = {
      "2026-11-07": allHours(800),
      "2026-11-11": allHours(950),
    };
    expect(pressingDailyScheduleForDay(schedules, "2026-11-06").hours).toEqual({});
    expect(pressingDailyScheduleForDay(schedules, "2026-11-09")).toEqual({
      hours: allHours(800), effectiveDay: "2026-11-07",
    });
    expect(pressingDailyScheduleForDay(schedules, "2026-11-11")).toEqual({
      hours: allHours(950), effectiveDay: "2026-11-11",
    });
  });

  it("does not apply a partially saved or invalid template", () => {
    expect(pressingDailyScheduleForDay({ "2026-11-07": { "7": 800 } }, "2026-11-08").hours).toEqual({});
    expect(pressingDailyScheduleForDay({
      "2026-11-07": allHours(800),
      "2026-11-09": { ...allHours(900), "11": 0 },
    }, "2026-11-10").effectiveDay).toBe("2026-11-07");
  });

  it("requires supervisor writes, saves atomically and keeps selected-day overrides", () => {
    const api = readFileSync("server/routes/factory/factoryPressingReportRoutes.ts", "utf8");
    const ui = readFileSync("client/src/pages/factory/PressingHourlyTargets.tsx", "utf8");
    expect(api).toContain('"/api/factory/pressing-machines/report/hourly-targets/daily-schedule"');
    expect(api).toContain("pressingHourlyDailySchedulesKg");
    expect(api).toContain("pressingDailyScheduleForDay");
    expect(api).toContain("if (!ctx.canCorrect)");
    expect(api).toContain("jsonb_build_object($2::text,$3::jsonb)");
    expect(api).toContain("const hourlyTargetsKg: Record<string, number> = { ...dailySchedule.hours }");
    expect(ui).toContain("Daily schedule");
    expect(ui).toContain("Save daily schedule");
    expect(ui).toContain('ENDPOINT + "/daily-schedule"');
  });
});
