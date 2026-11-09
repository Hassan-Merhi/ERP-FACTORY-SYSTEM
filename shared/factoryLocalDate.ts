import { PRESSING_TIME_ZONE } from "./pressingTimeZone";

/**
 * Calendar date in the Factory's Beirut timezone, even during DST changes.
 * A date-only string is NOT a UTC midnight timestamp.
 * Authorization and attendance approval remain server responsibilities.
 */
export function factoryLocalDate(value: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: PRESSING_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** UTC instants are only a display input; never shift or rewrite the saved instant. */
export function factoryLocalDateFromInstant(value: string): string | null {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) ? factoryLocalDate(instant) : null;
}

/** ISO calendar dates sort lexically; approval for past dates remains server enforced. */
export function factoryPastCalendarDates(dates: readonly string[], today = factoryLocalDate()): string[] {
  return [...new Set(dates.filter((date) => date < today))];
}
