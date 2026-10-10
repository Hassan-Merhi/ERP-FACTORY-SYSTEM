/**
 * Recognises the closed-period rejection raised by the database guard
 * (server/services/accounting/closedPeriodGuard.ts). Dependency-free so the
 * shared HTTP helpers can use it. Drizzle wraps driver errors ("Failed query:
 * ..."), so the original PostgreSQL error is looked for along `cause`.
 */

export const CLOSED_PERIOD_ERROR_CODE = "EPL01";
const MARKER = "ACCOUNTING_PERIOD_CLOSED";

function errorField(error: unknown, field: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[field];
}

/** True when an error (or the driver error it wraps) is the closed-period rejection. */
export function isClosedPeriodError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (errorField(current, "code") === CLOSED_PERIOD_ERROR_CODE) return true;
    const message = errorField(current, "message");
    if (typeof message === "string" && message.includes(MARKER)) return true;
    current = errorField(current, "cause");
  }
  return false;
}

const LOCK_DETAIL = /closed through (\d{4}-\d{2}-\d{2}), so an entry dated (\d{4}-\d{2}-\d{2})/;
/** The opening-balance lock's text (services/accounting/openingBalanceLock.ts, wave 12). */
const OPENING_LOCK_DETAIL = /closed through (\d{4}-\d{2}-\d{2}), so an opening balance cannot/;

/**
 * HTTP mapping for routes: 409 Conflict. The message is rebuilt from the two
 * dates in the trigger's text so the client catalogs can translate it (see
 * phase3RemainingTranslations.part27.ts).
 */
export function closedPeriodErrorResponse(
  error: unknown
): { status: 409; body: { message: string; code: "ACCOUNTING_PERIOD_CLOSED" } } | null {
  if (!isClosedPeriodError(error)) return null;
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = errorField(current, "message");
    const opening = typeof candidate === "string" ? candidate.match(OPENING_LOCK_DETAIL) : null;
    if (opening) {
      const [, closedThrough] = opening;
      return {
        status: 409,
        body: {
          message: `Accounting period closed: the books are closed through ${closedThrough}, so an opening balance cannot be created or changed. Post an adjusting journal dated after the closed period instead.`,
          code: "ACCOUNTING_PERIOD_CLOSED",
        },
      };
    }
    const detail = typeof candidate === "string" ? candidate.match(LOCK_DETAIL) : null;
    if (detail) {
      const [, closedThrough, entryDate] = detail;
      return {
        status: 409,
        body: {
          message: `Accounting period closed: the books are closed through ${closedThrough}, so an entry dated ${entryDate} cannot be created, changed or deleted.`,
          code: "ACCOUNTING_PERIOD_CLOSED",
        },
      };
    }
    current = errorField(current, "cause");
  }
  return { status: 409, body: { message: "Accounting period closed.", code: "ACCOUNTING_PERIOD_CLOSED" } };
}
