/**
 * Mirror the server's Beirut-calendar rule for UI feedback only.
 * All prior-day approval remains independently enforced by the server.
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
