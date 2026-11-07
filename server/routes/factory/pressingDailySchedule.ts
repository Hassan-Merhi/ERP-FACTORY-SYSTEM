/** Fixed recurring KG targets for each Beirut production hour, versioned by start day.
 * Older schedules are retained so historical performance comparisons cannot drift. */
export const PRESSING_DAILY_HOURS = Array.from({ length: 10 }, (_, index) => index + 7);

export type PressingDailySchedule = { hours: Record<string, number>; effectiveDay: string | null };

export function pressingDailyScheduleForDay(stored: unknown, day: string): PressingDailySchedule {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
    return { hours: {}, effectiveDay: null };
  }
  const schedules = stored as Record<string, unknown>;
  const effectiveDays = Object.keys(schedules)
    .filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && key <= day)
    .sort()
    .reverse();
  for (const effectiveDay of effectiveDays) {
    const raw = schedules[effectiveDay];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const entries = raw as Record<string, unknown>;
    const hours: Record<string, number> = {};
    for (const hour of PRESSING_DAILY_HOURS) {
      const value = Number(entries[String(hour)]);
      if (!Number.isFinite(value) || value < 0.001 || value > 100000) break;
      hours[String(hour)] = value;
    }
    if (Object.keys(hours).length === PRESSING_DAILY_HOURS.length) {
      return { hours, effectiveDay };
    }
  }
  return { hours: {}, effectiveDay: null };
}

/** ISO/JavaScript day number: 1=Monday through 6=Saturday; 0=Sunday. */
export const PRESSING_WORKDAYS = [1, 2, 3, 4, 5, 6] as const;

export function pressingWeekdayFromDate(day: string): number {
  // Noon UTC gives the unambiguous calendar weekday of the Beirut date string,
  // even when local GMT offset changes for daylight saving time.
  return new Date(day + "T12:00:00Z").getUTCDay();
}

function validatedHourTargets(raw: unknown): Record<string, number> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const values = raw as Record<string, unknown>;
  const targets: Record<string, number> = {};
  for (const hour of PRESSING_DAILY_HOURS) {
    const rawValue = values[String(hour)];
    if (rawValue === undefined || rawValue === null || rawValue === "") return null;
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0.001 || value > 100000) return null;
    targets[String(hour)] = value;
  }
  return targets;
}

/**
 * Effective-dated Monday–Saturday schedules are independently versioned per weekday:
 * { "2026-11-07": { "1": {"7":800, ...}, "6": {...} } }.
 * Existing all-day templates remain the fallback until each weekday is configured.
 * Once weekly mode begins, Sundays have no recurring target, while Sundays before
 * the first weekly edit retain their original historical comparisons.
 */
export function pressingWeeklyScheduleForWeekday(
  weeklyStored: unknown,
  legacyDailyStored: unknown,
  asOfDay: string,
  weekday: number,
): PressingDailySchedule {
  if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
    return { hours: {}, effectiveDay: null };
  }
  const weekly = weeklyStored && typeof weeklyStored === "object" && !Array.isArray(weeklyStored)
    ? weeklyStored as Record<string, unknown>
    : {};
  const dates = Object.keys(weekly)
    .filter(key => /^\d{4}-\d{2}-\d{2}$/.test(key) && key <= asOfDay)
    .sort().reverse();
  if (weekday === 0) {
    // No new Sunday targets after the first weekday schedule takes effect.
    return dates.length
      ? { hours: {}, effectiveDay: null }
      : pressingDailyScheduleForDay(legacyDailyStored, asOfDay);
  }
  for (const effectiveDay of dates) {
    const stored = weekly[effectiveDay];
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) continue;
    const hours = validatedHourTargets((stored as Record<string, unknown>)[String(weekday)]);
    if (hours) return { hours, effectiveDay };
  }
  return pressingDailyScheduleForDay(legacyDailyStored, asOfDay);
}

export function pressingWeeklyScheduleForDay(
  weeklyStored: unknown, legacyDailyStored: unknown, day: string,
): PressingDailySchedule {
  return pressingWeeklyScheduleForWeekday(
    weeklyStored, legacyDailyStored, day, pressingWeekdayFromDate(day)
  );
}
