import type { Request } from "express";

/**
 * Returns today's date string (YYYY-MM-DD) in the client's local timezone.
 * Reads the X-Client-Date header sent by the browser (which uses the user's
 * system timezone). Falls back to UTC today if the header is absent.
 */
export function getClientDate(req: Request): string {
  const header = req.headers?.["x-client-date"];
  if (typeof header === "string" && /^\d{4}-\d{2}-\d{2}$/.test(header)) {
    return header;
  }
  return new Date().toISOString().split("T")[0];
}

/**
 * Returns "today" (YYYY-MM-DD) as a single company-wide business date, computed
 * from the company's own configured timezone (company_settings.timezone) —
 * never from the requesting browser/user's clock or timezone.
 *
 * This MUST be the source of truth for anything shared company-wide and date-scoped
 * (e.g. "has today's exchange rate been set for this company"), so that two users in
 * different timezones/devices always agree on what date "today" is for that company.
 * Falls back to UTC today if the company has no timezone configured.
 */
export function getCompanyBusinessDate(timezone: string | null | undefined): string {
  if (timezone) {
    try {
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date());
    } catch {
      // Invalid timezone string — fall through to UTC.
    }
  }
  return new Date().toISOString().split("T")[0];
}
