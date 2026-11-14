/** Shared security denial logging; reason levels preserved. */
import { logger } from "./lib/logger";

const EXPECTED_ANONYMOUS_SESSION_REASONS = new Set(["SESSION_REQUIRED", "SESSION_USER_REQUIRED"]);

// Session expiry is a normal lifecycle event (browser left open, user idle, etc.).
// Log at WARN so operators can distinguish routine expiry from real security incidents.
const SESSION_EXPIRY_REASONS = new Set([
  "SESSION_IDLE_EXPIRED",
  "SESSION_ABSOLUTE_EXPIRED",
  "SESSION_TIMESTAMPS_INVALID",
  "SESSION_COMPANY_REQUIRED",
]);

export function logDenied(params: {
  userId?: string | null;
  username?: string | null;
  role?: string | null;
  companyId?: number | null;
  method: string;
  path: string;
  reason: string;
}) {
  const payload = JSON.stringify({
    event: "access_denied",
    ts: new Date().toISOString(),
    userId: params.userId ?? null,
    role: params.role ?? null,
    companyId: params.companyId ?? null,
    method: params.method,
    path: params.path,
    reason: params.reason,
  });

  const isExpectedAnonymousRequest = !params.userId && EXPECTED_ANONYMOUS_SESSION_REASONS.has(params.reason);

  if (isExpectedAnonymousRequest) {
    logger.info(payload);
    return;
  }

  if (SESSION_EXPIRY_REASONS.has(params.reason)) {
    logger.warn(payload);
    return;
  }

  logger.error(payload);
}
