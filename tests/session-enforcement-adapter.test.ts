import { describe, expect, it } from "vitest";
import {
  LAST_SEEN_WRITE_INTERVAL_MS,
  enforceRuntimeSession,
} from "../server/services/security/sessionEnforcementAdapter";

function session(overrides: Record<string, unknown> = {}) {
  return {
    userId: "user-1",
    currentCompanyId: 10,
    createdAt: 1_000,
    lastSeenAt: 1_500,
    absoluteExpiresAt: 500_000,
    credentialVersion: 0,
    ...overrides,
  } as any;
}

describe("session enforcement adapter", () => {
  it("accepts and touches a valid company-scoped session", () => {
    const state = session({ absoluteExpiresAt: 500_000 });
    const result = enforceRuntimeSession(state, { requireCompanyContext: true, now: 70_000 });
    expect(result).toEqual({ valid: true, code: "SESSION_VALID", status: 401, destroySession: false });
    expect(state.lastSeenAt).toBe(70_000);
  });

  it("does not rewrite the session for every request inside the stamp interval", () => {
    const state = session();
    const result = enforceRuntimeSession(state, {
      requireCompanyContext: true,
      now: 1_500 + LAST_SEEN_WRITE_INTERVAL_MS - 1,
    });
    expect(result.valid).toBe(true);
    // An unchanged session is not saved, so it cannot overwrite a company switch.
    expect(state.lastSeenAt).toBe(1_500);
  });

  it("upgrades an existing authenticated legacy session once", () => {
    const state = session({
      createdAt: undefined,
      lastSeenAt: undefined,
      absoluteExpiresAt: undefined,
      credentialVersion: undefined,
      loginAt: "1970-01-01T00:00:01.000Z",
    });
    const result = enforceRuntimeSession(state, { requireCompanyContext: true, now: 2_000 });
    expect(result.valid).toBe(true);
    expect(state.createdAt).toBe(1_000);
    expect(state.credentialVersion).toBe(0);
  });

  it("allows personal-account routes without company context", () => {
    const result = enforceRuntimeSession(session({ currentCompanyId: undefined }), {
      requireCompanyContext: false,
      now: 2_000,
    });
    expect(result.valid).toBe(true);
  });

  it("denies company routes when no company is selected", () => {
    const result = enforceRuntimeSession(session({ currentCompanyId: undefined }), {
      requireCompanyContext: true,
      now: 2_000,
    });
    expect(result).toMatchObject({ valid: false, code: "SESSION_COMPANY_REQUIRED", status: 401 });
  });

  it("keeps sessions active for 12 hours of inactivity", () => {
    const lastSeenAt = 10_000;
    expect(
      enforceRuntimeSession(session({ lastSeenAt, absoluteExpiresAt: lastSeenAt + 13 * 60 * 60 * 1000 }), {
        requireCompanyContext: true,
        now: lastSeenAt + 12 * 60 * 60 * 1000,
      })
    ).toMatchObject({ valid: true, code: "SESSION_VALID", destroySession: false });

    expect(
      enforceRuntimeSession(session({ lastSeenAt, absoluteExpiresAt: lastSeenAt + 13 * 60 * 60 * 1000 }), {
        requireCompanyContext: true,
        now: lastSeenAt + 12 * 60 * 60 * 1000 + 1,
      })
    ).toMatchObject({ valid: false, code: "SESSION_IDLE_EXPIRED", destroySession: true });
  });

  it("expires idle and absolute-lifetime sessions", () => {
    expect(
      enforceRuntimeSession(session({ lastSeenAt: 1 }), { requireCompanyContext: true, now: 50_000_000 })
    ).toMatchObject({ valid: false, code: "SESSION_IDLE_EXPIRED", destroySession: true });
    expect(
      enforceRuntimeSession(session({ absoluteExpiresAt: 1_999 }), { requireCompanyContext: true, now: 2_000 })
    ).toMatchObject({ valid: false, code: "SESSION_ABSOLUTE_EXPIRED", destroySession: true });
  });

  it("enforces credential revocation when an active version is supplied", () => {
    const result = enforceRuntimeSession(session({ credentialVersion: 1, activeCredentialVersion: 2 }), {
      requireCompanyContext: true,
      now: 2_000,
    });
    expect(result).toMatchObject({ valid: false, code: "SESSION_CREDENTIALS_REVOKED", destroySession: true });
  });

  it("enforces recent password confirmation for sensitive routes", () => {
    const denied = enforceRuntimeSession(session({ passwordConfirmedAt: undefined }), {
      requireCompanyContext: true,
      requireRecentPasswordConfirmation: true,
      now: 2_000,
    });
    expect(denied).toMatchObject({ valid: false, code: "SESSION_PASSWORD_CONFIRMATION_REQUIRED", status: 403 });
  });
});
