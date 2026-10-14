export interface SessionSecurityState {
  userId?: string | number | null;
  createdAt?: number | null;
  lastSeenAt?: number | null;
  absoluteExpiresAt?: number | null;
  credentialVersion?: number | null;
  currentCompanyId?: number | null;
  passwordConfirmedAt?: number | null;
}

export interface SessionSecurityInput {
  session: SessionSecurityState | null | undefined;
  activeCredentialVersion: number;
  now?: number;
  idleTimeoutMs?: number;
  absoluteLifetimeMs?: number;
  requireCompanyContext?: boolean;
  requireRecentPasswordConfirmation?: boolean;
  passwordConfirmationMaxAgeMs?: number;
}

export type SessionSecurityCode =
  | "SESSION_REQUIRED"
  | "SESSION_TIMESTAMPS_INVALID"
  | "SESSION_IDLE_EXPIRED"
  | "SESSION_ABSOLUTE_EXPIRED"
  | "SESSION_CREDENTIALS_REVOKED"
  | "SESSION_COMPANY_REQUIRED"
  | "SESSION_PASSWORD_CONFIRMATION_REQUIRED"
  | "SESSION_VALID";

export interface SessionSecurityDecision {
  valid: boolean;
  code: SessionSecurityCode;
}

export class SessionSecurityError extends Error {
  readonly code: SessionSecurityCode;

  constructor(code: SessionSecurityCode) {
    super(code === "SESSION_REQUIRED" ? "Unauthorized" : "Forbidden");
    this.name = "SessionSecurityError";
    this.code = code;
  }
}

export const DEFAULT_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
const DEFAULT_ABSOLUTE_LIFETIME_MS = 12 * 60 * 60 * 1000;
const DEFAULT_PASSWORD_CONFIRMATION_MAX_AGE_MS = 5 * 60 * 1000;

function positiveTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Pure, fail-closed session validation boundary.
 *
 * Credential-version comparison makes password resets and explicit security
 * revocations invalidate every older session without relying on cookie expiry.
 */
export function decideSessionSecurity(input: SessionSecurityInput): SessionSecurityDecision {
  const session = input.session;
  if (!session?.userId) return { valid: false, code: "SESSION_REQUIRED" };

  const now = input.now ?? Date.now();
  const createdAt = session.createdAt;
  const lastSeenAt = session.lastSeenAt;
  if (!positiveTimestamp(createdAt) || !positiveTimestamp(lastSeenAt) || createdAt > now || lastSeenAt > now) {
    return { valid: false, code: "SESSION_TIMESTAMPS_INVALID" };
  }

  const idleTimeoutMs = input.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0 || now - lastSeenAt > idleTimeoutMs) {
    return { valid: false, code: "SESSION_IDLE_EXPIRED" };
  }

  const absoluteLifetimeMs = input.absoluteLifetimeMs ?? DEFAULT_ABSOLUTE_LIFETIME_MS;
  const configuredAbsoluteExpiry = session.absoluteExpiresAt;
  const absoluteExpiry = positiveTimestamp(configuredAbsoluteExpiry)
    ? configuredAbsoluteExpiry
    : createdAt + absoluteLifetimeMs;
  if (!Number.isFinite(absoluteLifetimeMs) || absoluteLifetimeMs <= 0 || absoluteExpiry <= now) {
    return { valid: false, code: "SESSION_ABSOLUTE_EXPIRED" };
  }

  if (
    !Number.isInteger(input.activeCredentialVersion) ||
    input.activeCredentialVersion < 0 ||
    !Number.isInteger(session.credentialVersion) ||
    session.credentialVersion !== input.activeCredentialVersion
  ) {
    return { valid: false, code: "SESSION_CREDENTIALS_REVOKED" };
  }

  if (input.requireCompanyContext !== false) {
    if (!Number.isInteger(session.currentCompanyId) || Number(session.currentCompanyId) <= 0) {
      return { valid: false, code: "SESSION_COMPANY_REQUIRED" };
    }
  }

  if (input.requireRecentPasswordConfirmation) {
    const confirmedAt = session.passwordConfirmedAt;
    const maxAge = input.passwordConfirmationMaxAgeMs ?? DEFAULT_PASSWORD_CONFIRMATION_MAX_AGE_MS;
    if (
      !positiveTimestamp(confirmedAt) ||
      !Number.isFinite(maxAge) ||
      maxAge <= 0 ||
      confirmedAt > now ||
      now - confirmedAt > maxAge
    ) {
      return { valid: false, code: "SESSION_PASSWORD_CONFIRMATION_REQUIRED" };
    }
  }

  return { valid: true, code: "SESSION_VALID" };
}

export function nextCredentialVersion(currentVersion: number): number {
  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion >= Number.MAX_SAFE_INTEGER) {
    throw new SessionSecurityError("SESSION_CREDENTIALS_REVOKED");
  }
  return currentVersion + 1;
}
