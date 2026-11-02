/** Mirror the server's Asia/Beirut calendar rule for early UI feedback only.
 * The server always enforces this independently.
 */
export function attendanceToday(): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Beirut",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const p = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${p("year")}-${p("month")}-${p("day")}`;
}

export function attendancePastDates(dates: string[]): string[] {
  const today = attendanceToday();
  return [...new Set(dates.filter((date) => date < today))];
}

export interface AttendanceAdminCredentials {
  adminUsername: string;
  adminPassword: string;
}
