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

/** HTTP mapping for routes: 409 Conflict with the trigger's explanation. */
export function closedPeriodErrorResponse(
  error: unknown
): { status: 409; body: { message: string; code: "ACCOUNTING_PERIOD_CLOSED" } } | null {
  if (!isClosedPeriodError(error)) return null;
  let current: unknown = error;
  let message = "The accounting period is closed.";
  for (let depth = 0; depth < 4 && current; depth += 1) {
    const candidate = errorField(current, "message");
    if (typeof candidate === "string" && candidate.includes(MARKER)) {
      message = candidate.slice(candidate.indexOf(MARKER)).replace(/^ACCOUNTING_PERIOD_CLOSED:\s*/, "");
      break;
    }
    current = errorField(current, "cause");
  }
  return { status: 409, body: { message: `Accounting period closed: ${message}`, code: "ACCOUNTING_PERIOD_CLOSED" } };
}
