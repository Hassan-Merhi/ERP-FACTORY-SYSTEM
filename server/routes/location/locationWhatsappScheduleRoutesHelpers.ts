// Extracted from ./locationWhatsappScheduleRoutes.ts

export const LOCATION_WHATSAPP_PERMISSION = "exp_whatsapp_send";

const DEFAULT_TIMEZONE = "Africa/Lubumbashi";

const DAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, timezone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.get("year")),
    month: Number(parts.get("month")),
    day: Number(parts.get("day")),
    weekday: DAY_INDEX[parts.get("weekday") || ""] ?? date.getUTCDay(),
    hour: Number(parts.get("hour")),
    minute: Number(parts.get("minute")),
  };
}

function zonedLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string
): Date {
  const desired = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  let guess = desired;
  for (let i = 0; i < 4; i++) {
    const current = localParts(new Date(guess), timezone);
    const represented = Date.UTC(current.year, current.month - 1, current.day, current.hour, current.minute, 0, 0);
    const delta = desired - represented;
    guess += delta;
    if (delta === 0) break;
  }
  return new Date(guess);
}

type WhatsappScheduleRow = {
  enabled?: boolean | null;
  timezone?: string | null;
  send_time?: string | null;
  frequency?: string | null;
  days_of_week?: unknown;
  last_scheduled_for?: unknown;
  include_cost?: boolean | null;
  include_zero_stock?: boolean | null;
  include_negative_stock?: boolean | null;
  stock_group_id?: number | string | null;
  category_id?: number | string | null;
  last_attempt_at?: string | Date | null;
  last_sent_at?: string | Date | null;
  last_status?: string | null;
  last_error?: string | null;
};

function lastScheduledLocalDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function computeNextSendAt(row: WhatsappScheduleRow, now = new Date()): string | null {
  if (!row?.enabled) return null;
  const timezone = row.timezone || DEFAULT_TIMEZONE;
  if (!isValidTimezone(timezone)) return null;
  const sendTime = typeof row.send_time === "string" ? row.send_time.slice(0, 5) : "18:00";
  const [sendHour, sendMinute] = sendTime.split(":").map(Number);
  const current = localParts(now, timezone);
  const currentLocalTime = `${String(current.hour).padStart(2, "0")}:${String(current.minute).padStart(2, "0")}`;
  const allowedDays =
    row.frequency === "selected_days"
      ? new Set((Array.isArray(row.days_of_week) ? row.days_of_week : []).map(Number))
      : new Set([0, 1, 2, 3, 4, 5, 6]);
  const already = lastScheduledLocalDate(row.last_scheduled_for);
  const anchor = Date.UTC(current.year, current.month - 1, current.day);

  for (let offset = 0; offset < 8; offset++) {
    const calendar = new Date(anchor + offset * 24 * 60 * 60 * 1000);
    const year = calendar.getUTCFullYear();
    const month = calendar.getUTCMonth() + 1;
    const day = calendar.getUTCDate();
    const weekday = calendar.getUTCDay();
    if (!allowedDays.has(weekday)) continue;
    const localDate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    if (offset === 0) {
      if (already === localDate) continue;
      if (currentLocalTime >= sendTime) return now.toISOString();
    }
    return zonedLocalToUtc(year, month, day, sendHour, sendMinute, timezone).toISOString();
  }
  return null;
}

export function defaultSchedule(locationId: number) {
  return {
    locationId,
    enabled: false,
    frequency: "daily" as const,
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    sendTime: "18:00",
    timezone: DEFAULT_TIMEZONE,
    includeCost: false,
    includeZeroStock: false,
    includeNegativeStock: true,
    stockGroupId: null as number | null,
    categoryId: null as number | null,
    lastAttemptAt: null as string | null,
    lastSentAt: null as string | null,
    lastScheduledFor: null as string | null,
    lastStatus: null as string | null,
    lastError: null as string | null,
    nextSendAt: null as string | null,
  };
}

export function serializeSchedule(row: WhatsappScheduleRow, locationId: number) {
  if (!row) return defaultSchedule(locationId);
  const sendTime = typeof row.send_time === "string" ? row.send_time.slice(0, 5) : "18:00";
  return {
    locationId,
    enabled: row.enabled === true,
    frequency: row.frequency === "selected_days" ? "selected_days" : "daily",
    daysOfWeek: Array.isArray(row.days_of_week) ? row.days_of_week.map(Number) : [0, 1, 2, 3, 4, 5, 6],
    sendTime,
    timezone: row.timezone || DEFAULT_TIMEZONE,
    includeCost: row.include_cost === true,
    includeZeroStock: row.include_zero_stock === true,
    includeNegativeStock: row.include_negative_stock !== false,
    stockGroupId: row.stock_group_id == null ? null : Number(row.stock_group_id),
    categoryId: row.category_id == null ? null : Number(row.category_id),
    lastAttemptAt: row.last_attempt_at ? new Date(row.last_attempt_at).toISOString() : null,
    lastSentAt: row.last_sent_at ? new Date(row.last_sent_at).toISOString() : null,
    lastScheduledFor: lastScheduledLocalDate(row.last_scheduled_for),
    lastStatus: row.last_status ?? null,
    lastError: row.last_error ?? null,
    nextSendAt: computeNextSendAt(row),
  };
}
