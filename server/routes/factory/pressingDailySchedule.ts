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
