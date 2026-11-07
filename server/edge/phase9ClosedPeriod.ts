/**
 * A record replayed into a closed accounting period can never apply: the
 * closed-period guard (server/services/accounting/closedPeriodGuard.ts)
 * refuses it with SQLSTATE EPL01. Phase 9 handlers treat other database errors
 * as transient and leave them for the next apply run, which would retry this
 * one forever and stop the stream. This turns it into a reject-only conflict
 * (no stream declares PHASE9_PERIOD_CLOSED overridable), so an Admin or
 * Developer rejects it and re-enters the fact in an open period.
 */
import { isClosedPeriodError } from "../lib/closedPeriodError";
import { getErrorMessage } from "../lib/httpHandlers";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";

export const PHASE9_PERIOD_CLOSED = "PHASE9_PERIOD_CLOSED";

export function throwIfClosedPeriod(error: unknown): void {
  if (isClosedPeriodError(error)) {
    throw new Phase9EventConflict(PHASE9_PERIOD_CLOSED, { message: getErrorMessage(error) });
  }
}
