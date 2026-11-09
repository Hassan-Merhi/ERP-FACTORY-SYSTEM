/**
 * Pressing hourly KG target rules and storage, shared by the report routes.
 *
 * Kept separate from factoryPressingReportRoutes.ts so the validation, the
 * override merge and the atomic JSONB writes can be tested directly (see
 * tests/pressing-daily-schedule.test.ts) instead of by reading route source.
 */
import { z } from "zod";
import { PRESSING_DAILY_HOURS } from "./pressingDailySchedule";

/** Highest accepted target for one hour, in KG. Zero means "no required target". */
export const PRESSING_MAX_TARGET_KG = 100_000;

/** One hourly KG target: zero allowed (no required target), negatives and absurd values refused. */
export const pressingTargetKgSchema = z.number().finite().min(0).max(PRESSING_MAX_TARGET_KG);

/** Body of PUT …/hourly-targets/daily-schedule: one Monday–Saturday weekday and its ten hourly targets. */
export const pressingWeeklyScheduleInputSchema = z
  .object({
    weekday: z.number().int().min(1).max(6),
    targetsKg: z.array(pressingTargetKgSchema).length(PRESSING_DAILY_HOURS.length),
  })
  .strict();

/** Only Admin and Owner (never a POS view-only session) may change pressing targets. */
export function canEditPressingTargets(role: string, posViewOnly: boolean): boolean {
  return (role === "Admin" || role === "Owner") && !posViewOnly;
}

/**
 * A stored date-specific override for one hour. Missing values (undefined,
 * null or "") are not overrides; zero is an explicit "no required target".
 */
export function pressingHourTargetOverride(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 && value <= PRESSING_MAX_TARGET_KG ? value : null;
}

/** The recurring schedule for a day, with that day's valid hourly overrides applied on top. */
export function mergePressingHourlyTargets(
  scheduleHours: Record<string, number>,
  rawOverrides: unknown
): Record<string, number> {
  const merged: Record<string, number> = { ...scheduleHours };
  if (!rawOverrides || typeof rawOverrides !== "object" || Array.isArray(rawOverrides)) return merged;
  for (const hour of PRESSING_DAILY_HOURS) {
    const override = pressingHourTargetOverride((rawOverrides as Record<string, unknown>)[String(hour)]);
    if (override !== null) merged[String(hour)] = override;
  }
  return merged;
}

/** Ten hourly targets keyed by Beirut hour ("7" … "16"). */
export function pressingScheduleHours(targetsKg: readonly number[]): Record<string, number> {
  const hours: Record<string, number> = {};
  PRESSING_DAILY_HOURS.forEach((hour, index) => {
    hours[String(hour)] = targetsKg[index];
  });
  return hours;
}

interface Queryable {
  query: (text: string, values?: unknown[]) => Promise<unknown>;
}

/**
 * Save one weekday's recurring schedule effective from `effectiveDay`, in a
 * single atomic JSONB patch that keeps every other weekday, earlier effective
 * dates, date overrides and unrelated company settings.
 */
export async function savePressingWeeklySchedule(
  db: Queryable,
  input: { companyId: number; effectiveDay: string; weekday: number; hours: Record<string, number> }
): Promise<void> {
  await db.query(
    "INSERT INTO factory_settings (company_id,extra_settings,updated_at) " +
      "VALUES ($1,jsonb_build_object('pressingHourlyWeeklySchedulesKg'," +
      "jsonb_build_object($2::text,jsonb_build_object($3::text,$4::jsonb))),now()) " +
      "ON CONFLICT (company_id) DO UPDATE SET " +
      "extra_settings=COALESCE(factory_settings.extra_settings,'{}'::jsonb) || " +
      "jsonb_build_object('pressingHourlyWeeklySchedulesKg'," +
      "COALESCE(factory_settings.extra_settings->'pressingHourlyWeeklySchedulesKg','{}'::jsonb) || " +
      "jsonb_build_object($2::text," +
      "COALESCE(factory_settings.extra_settings->'pressingHourlyWeeklySchedulesKg'->($2::text),'{}'::jsonb) || " +
      "jsonb_build_object($3::text,$4::jsonb))),updated_at=now()",
    [input.companyId, input.effectiveDay, String(input.weekday), JSON.stringify(input.hours)]
  );
}

/**
 * Save one date-specific hourly override, in a single atomic JSONB patch that
 * keeps other hours, other dates, recurring schedules and unrelated settings.
 */
export async function savePressingDateHourTarget(
  db: Queryable,
  input: { companyId: number; day: string; hour: number; targetKgPerHour: number }
): Promise<void> {
  await db.query(
    "INSERT INTO factory_settings (company_id,extra_settings,updated_at) " +
      "VALUES ($1,jsonb_build_object('pressingHourlyTargetsByDateKg'," +
      "jsonb_build_object($2::text,jsonb_build_object($3::text,$4::numeric))),now()) " +
      "ON CONFLICT (company_id) DO UPDATE SET " +
      "extra_settings=COALESCE(factory_settings.extra_settings,'{}'::jsonb) || " +
      "jsonb_build_object('pressingHourlyTargetsByDateKg'," +
      "COALESCE(factory_settings.extra_settings->'pressingHourlyTargetsByDateKg','{}'::jsonb) || " +
      "jsonb_build_object($2::text," +
      "COALESCE(factory_settings.extra_settings->'pressingHourlyTargetsByDateKg'->($2::text),'{}'::jsonb) || " +
      "jsonb_build_object($3::text,$4::numeric))),updated_at=now()",
    [input.companyId, input.day, String(input.hour), input.targetKgPerHour]
  );
}
