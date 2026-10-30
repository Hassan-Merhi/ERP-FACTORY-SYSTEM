/**
 * Pressing production always uses Beirut local wall time for display, report
 * date boundaries and recording the daily production date.
 *
 * Save scan instants in UTC/timestamptz; never add a fixed +2 hour offset.
 * Beirut is UTC+2 in winter and UTC+3 during daylight saving time.
 */
export const PRESSING_TIME_ZONE = "Asia/Beirut" as const;
