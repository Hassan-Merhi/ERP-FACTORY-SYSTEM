/**
 * Booking Info is a private customer-order field: only Admin, Owner and
 * Developer see it in order listings, and it is free text of bounded length.
 */
const BOOKING_INFO_VIEWER_ROLES = ["admin", "owner", "developer"];
const BOOKING_INFO_MAX_LENGTH = 2000;

export function canViewBookingInfo(session: { currentRole?: string | null; role?: string | null }): boolean {
  const role = (session.currentRole || session.role || "").toLowerCase();
  return BOOKING_INFO_VIEWER_ROLES.includes(role);
}

export function isValidBookingInfo(value: unknown): value is string {
  return typeof value === "string" && value.length <= BOOKING_INFO_MAX_LENGTH;
}
