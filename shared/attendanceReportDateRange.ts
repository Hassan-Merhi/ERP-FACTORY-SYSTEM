/**
 * Guard both the browser and the backend against partially entered dates.
 * Native date inputs may emit years such as 0002 while a user edits 2026.
 * Without this cap the server creates hundreds of thousands of day columns.
 */
export const ATTENDANCE_REPORT_MAX_DAYS = 366;
const ONE_DAY_MS = 86_400_000;

function utcMidnight(isoDate: string): number | null {
  if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(isoDate)) return null;
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString().slice(0, 10) === isoDate ? time : null;
}

export function validateAttendanceReportDateRange(startDate: string, endDate: string): string | null {
  const startMs = utcMidnight(startDate);
  const endMs = utcMidnight(endDate);
  if (startMs === null || endMs === null) return "Enter valid report start and end dates.";
  if (endMs < startMs) return "Report end date must not be earlier than the start date.";
  if ((endMs - startMs) / ONE_DAY_MS >= ATTENDANCE_REPORT_MAX_DAYS) {
    return `Choose a report period of no more than ${ATTENDANCE_REPORT_MAX_DAYS} days.`;
  }
  return null;
}
