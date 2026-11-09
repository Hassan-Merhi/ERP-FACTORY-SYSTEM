/**
 * Pressing hourly targets are stored with atomic JSONB patches in the
 * company's factory_settings row. Saving one weekday or one date-specific hour
 * must keep every other weekday, earlier effective dates, other hours, other
 * dates and unrelated settings, and must never touch another company.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import {
  pressingScheduleHours,
  savePressingDateHourTarget,
  savePressingWeeklySchedule,
} from "../server/routes/factory/pressingHourlyTargetRules";
import { PRESSING_DAILY_HOURS } from "../server/routes/factory/pressingDailySchedule";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "presstgtstore";
const OTHER_PREFIX = "presstgtother";
const hours = (kg: number) => pressingScheduleHours(PRESSING_DAILY_HOURS.map(() => kg));

async function extraSettings(companyId: number): Promise<Record<string, unknown>> {
  const result = await pool.query<{ extra: Record<string, unknown> }>(
    "SELECT extra_settings AS extra FROM factory_settings WHERE company_id=$1",
    [companyId]
  );
  return result.rows[0]?.extra ?? {};
}

describe("pressing hourly target storage", () => {
  let ctx: TestContext;
  let other: TestContext;

  beforeAll(async () => {
    ctx = await seedTestData(PREFIX);
    other = await seedTestData(OTHER_PREFIX);
    for (const companyId of [ctx.companyId, other.companyId]) {
      await pool.query("DELETE FROM factory_settings WHERE company_id=$1", [companyId]);
    }
  }, 120_000);

  afterAll(async () => {
    for (const companyId of [ctx.companyId, other.companyId]) {
      await pool.query("DELETE FROM factory_settings WHERE company_id=$1", [companyId]);
    }
    await cleanupTestData(PREFIX);
    await cleanupTestData(OTHER_PREFIX);
    await closeTestServer();
  }, 120_000);

  it("creates the settings row on the first weekly save", async () => {
    await savePressingWeeklySchedule(pool, {
      companyId: ctx.companyId,
      effectiveDay: "2026-11-02",
      weekday: 1,
      hours: hours(800),
    });
    expect(await extraSettings(ctx.companyId)).toEqual({
      pressingHourlyWeeklySchedulesKg: { "2026-11-02": { "1": hours(800) } },
    });
  });

  it("keeps other weekdays, earlier versions, date overrides and unrelated settings", async () => {
    await pool.query("UPDATE factory_settings SET extra_settings = extra_settings || $2::jsonb WHERE company_id=$1", [
      ctx.companyId,
      JSON.stringify({ unrelatedFlag: true, pressingHourlyTargetsByDateKg: { "2026-11-05": { "9": 600 } } }),
    ]);
    await savePressingWeeklySchedule(pool, {
      companyId: ctx.companyId,
      effectiveDay: "2026-11-02",
      weekday: 6,
      hours: hours(750),
    });
    await savePressingWeeklySchedule(pool, {
      companyId: ctx.companyId,
      effectiveDay: "2026-11-09",
      weekday: 1,
      hours: { ...hours(950), "11": 0 },
    });
    await savePressingDateHourTarget(pool, {
      companyId: ctx.companyId,
      day: "2026-11-05",
      hour: 10,
      targetKgPerHour: 0,
    });
    await savePressingDateHourTarget(pool, {
      companyId: ctx.companyId,
      day: "2026-11-06",
      hour: 7,
      targetKgPerHour: 500,
    });

    expect(await extraSettings(ctx.companyId)).toEqual({
      unrelatedFlag: true,
      pressingHourlyWeeklySchedulesKg: {
        "2026-11-02": { "1": hours(800), "6": hours(750) },
        "2026-11-09": { "1": { ...hours(950), "11": 0 } },
      },
      pressingHourlyTargetsByDateKg: {
        "2026-11-05": { "9": 600, "10": 0 },
        "2026-11-06": { "7": 500 },
      },
    });
  });

  it("never writes another company's settings", async () => {
    expect(await extraSettings(other.companyId)).toEqual({});
  });
});
