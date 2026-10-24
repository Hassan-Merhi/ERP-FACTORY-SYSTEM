import { getErrorDetails } from "@shared/errorUtils";
import { logger } from "./logger";

/**
 * Database errors thrown by Drizzle can contain the full SQL text, parameters
 * and internal schema details in their message. Never echo those values to
 * a user-facing master-data form.
 *
 * Ordinary domain and validation errors are intentionally left to the calling
 * route so existing business-rule refusals retain their original messages.
 */
export function masterDataDbErrorResponse(
  error: unknown,
  entity: string,
  companyId?: number | null
): { status: number; body: { message: string; code: string } } | null {
  const outer = getErrorDetails(error);
  let cause = error;
  let pgCode: string | undefined;
  for (let i = 0; i < 5 && cause != null; i++) {
    const details = getErrorDetails(cause);
    if (typeof details.code === "string" && /^[0-9A-Z]{5}$/.test(details.code)) {
      pgCode = details.code;
      break;
    }
    if (typeof cause === "object" && "cause" in cause) {
      cause = cause.cause;
    } else {
      break;
    }
  }

  const isDbFailure = Boolean(pgCode)
    || /^(Failed query:|Query failed:)/i.test(outer.message)
    || outer.name === "DrizzleQueryError";
  if (!isDbFailure) return null;

  logger.error("[master-data] Database write failed", { error, entity, companyId, pgCode });
  if (pgCode === "23505") {
    return { status: 409, body: { message: "A record with the same code or name already exists.", code: "MASTER_DATA_DUPLICATE" } };
  }
  if (pgCode === "23503") {
    return { status: 409, body: { message: "A selected linked record no longer exists. Refresh and try again.", code: "MASTER_DATA_INVALID_REFERENCE" } };
  }
  if (pgCode === "23502" || pgCode === "23514" || pgCode === "22P02") {
    return { status: 400, body: { message: "Some required information is missing or invalid. Review the fields and try again.", code: "MASTER_DATA_INVALID_INPUT" } };
  }
  if (pgCode === "42703" || pgCode === "42P01") {
    return { status: 503, body: { message: "The database schema needs an administrator update.", code: "MASTER_DATA_SCHEMA_OUTDATED" } };
  }
  return { status: 500, body: { message: "Unable to save this record due to a database error. Please contact an administrator.", code: "MASTER_DATA_DATABASE_ERROR" } };
}
