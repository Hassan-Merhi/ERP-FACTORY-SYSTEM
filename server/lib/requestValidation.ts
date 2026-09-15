/** Shared request-boundary validation helpers for routes that persist typed SQL values. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Accept only real calendar dates in PostgreSQL's canonical YYYY-MM-DD shape.
 * This deliberately rejects values such as 2026-02-31 instead of allowing the
 * database driver to turn a malformed request into a 500.
 */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
