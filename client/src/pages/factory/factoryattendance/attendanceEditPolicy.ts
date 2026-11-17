/**
 * Mirror the server's Beirut-calendar rule for UI feedback only.
 * Server independently enforces the company-role and date approval policy.
 */
import { factoryLocalDate, factoryPastCalendarDates } from "@shared/factoryLocalDate";

export function attendanceToday(): string {
  return factoryLocalDate();
}

export function attendancePastDates(dates: string[]): string[] {
  return factoryPastCalendarDates(dates);
}

export interface AttendanceAdminCredentials {
  adminUsername: string;
  adminPassword: string;
}

/** Only authenticated Owners may bypass historical approval for Sunday dates. */
export function canSkipAttendanceApproval(role: string | undefined, dates: string[]): boolean {
  if (role === "Admin" || role === "Developer") return true;
  return role === "Owner" && dates.every((date) => /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    new Date(`${date}T00:00:00.000Z`).getUTCDay() === 0);
}
