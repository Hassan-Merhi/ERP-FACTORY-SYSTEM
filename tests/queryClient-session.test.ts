/**
 * Tests for the session-expiry verification gate that prevents false automatic
 * logouts.  A business endpoint returning 401 must NOT redirect to /login
 * unless /api/auth/me also confirms the session is gone.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  verifySessionExpired,
  handlePossibleSessionExpiry,
  _testOnly_resetSessionExpired,
  _testOnly_setRedirectFn,
} from "@/lib/queryClient";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResponse(status: number): Response {
  return new Response(null, { status });
}

/**
 * Returns a minimal fetch mock that answers /api/auth/me with the given status
 * and rejects any other URL (so tests stay focused and explicit).
 */
function mockAuthMeFetch(authMeStatus: number | "network-error"): typeof window.fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input
      : input instanceof URL ? input.href
      : (input as Request).url;
    if (url.includes("/api/auth/me")) {
      if (authMeStatus === "network-error") throw new TypeError("Failed to fetch");
      return makeResponse(authMeStatus);
    }
    throw new Error(`Unexpected fetch call to ${url}`);
  }) as unknown as typeof window.fetch;
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

let redirectTarget: string | null = null;

beforeEach(() => {
  redirectTarget = null;
  _testOnly_resetSessionExpired();
  _testOnly_setRedirectFn((href) => { redirectTarget = href; });
});

afterEach(() => {
  _testOnly_setRedirectFn(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// verifySessionExpired — pure async logic, no side-effects
// ---------------------------------------------------------------------------

describe("verifySessionExpired", () => {
  it("returns true when /api/auth/me returns 401", async () => {
    expect(await verifySessionExpired(mockAuthMeFetch(401))).toBe(true);
  });

  it("returns false when /api/auth/me returns 200 (session still valid)", async () => {
    expect(await verifySessionExpired(mockAuthMeFetch(200))).toBe(false);
  });

  it("returns false when /api/auth/me returns 500 (server problem)", async () => {
    expect(await verifySessionExpired(mockAuthMeFetch(500))).toBe(false);
  });

  it("returns false when /api/auth/me returns 502 (Render restart)", async () => {
    expect(await verifySessionExpired(mockAuthMeFetch(502))).toBe(false);
  });

  it("returns false on network error — never throws", async () => {
    expect(await verifySessionExpired(mockAuthMeFetch("network-error"))).toBe(false);
  });

  it("deduplicates concurrent calls — fires /api/auth/me exactly once", async () => {
    const fetch = mockAuthMeFetch(401);
    const [r1, r2, r3] = await Promise.all([
      verifySessionExpired(fetch),
      verifySessionExpired(fetch),
      verifySessionExpired(fetch),
    ]);
    expect(r1).toBe(true);
    expect(r2).toBe(true);
    expect(r3).toBe(true);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("resets the shared promise after resolution so subsequent calls work", async () => {
    const fetch = mockAuthMeFetch(401);
    await verifySessionExpired(fetch);
    // Second independent call after the first resolved
    await verifySessionExpired(fetch);
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// handlePossibleSessionExpiry — the full gate (verify then maybe redirect)
// ---------------------------------------------------------------------------

describe("handlePossibleSessionExpiry", () => {

  // ── Scenario 1: business 401, session still valid ─────────────────────────
  it("does NOT redirect when /api/auth/me returns 200", async () => {
    await handlePossibleSessionExpiry(makeResponse(401), "/api/reports/example", mockAuthMeFetch(200));
    expect(redirectTarget).toBeNull();
  });

  // ── Scenario 2: real session expiry ───────────────────────────────────────
  it("redirects to /login when /api/auth/me also returns 401", async () => {
    await handlePossibleSessionExpiry(makeResponse(401), "/api/reports/example", mockAuthMeFetch(401));
    expect(redirectTarget).toBe("/login");
  });

  it("redirects only once when multiple requests return 401 simultaneously", async () => {
    let redirectCount = 0;
    _testOnly_setRedirectFn((href) => { redirectTarget = href; redirectCount++; });

    const fetch = mockAuthMeFetch(401);
    await Promise.all([
      handlePossibleSessionExpiry(makeResponse(401), "/api/reports/example", fetch),
      handlePossibleSessionExpiry(makeResponse(401), "/api/reports/other",   fetch),
      handlePossibleSessionExpiry(makeResponse(401), "/api/inventory",        fetch),
    ]);

    expect(redirectTarget).toBe("/login");
    expect(redirectCount).toBe(1);
    // /api/auth/me called only once while the verification promise was in-flight
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("does not re-verify later 401s after expiry was already handled", async () => {
    const firstFetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/reports/example", firstFetch);
    expect((firstFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect(redirectTarget).toBe("/login");

    const laterFetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/notifications/unread-count", laterFetch);
    expect((laterFetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ── Scenario 3: temporary server problems ─────────────────────────────────
  it("does NOT redirect when /api/auth/me returns 502", async () => {
    await handlePossibleSessionExpiry(makeResponse(401), "/api/reports/example", mockAuthMeFetch(502));
    expect(redirectTarget).toBeNull();
  });

  it("does NOT redirect when /api/auth/me returns 500", async () => {
    await handlePossibleSessionExpiry(makeResponse(401), "/api/stats/net-profit", mockAuthMeFetch(500));
    expect(redirectTarget).toBeNull();
  });

  // ── Scenario 4: network failure during verification ───────────────────────
  it("does NOT redirect on /api/auth/me network error", async () => {
    await handlePossibleSessionExpiry(makeResponse(401), "/api/factory/bales", mockAuthMeFetch("network-error"));
    expect(redirectTarget).toBeNull();
  });

  // ── Scenario 5: login request 401 (wrong password — no redirect loop) ─────
  it("does NOT verify or redirect for /api/auth/login 401", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/auth/login", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("does NOT verify or redirect for /api/auth/me 401 (recursion guard)", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/auth/me", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("does NOT verify or redirect for /api/auth/logout 401", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/auth/logout", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("does NOT verify or redirect for /api/csrf-token 401", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/api/csrf-token", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ── Passthrough: non-401 and non-API ──────────────────────────────────────
  it("is a no-op for 403 responses (permission denial, not session expiry)", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(403), "/api/reports/example", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("is a no-op for non-API paths", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), "/some/static/path", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("is a no-op when pathname is null", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(401), null, fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  // ── CSRF mismatch (403) is unaffected ─────────────────────────────────────
  it("does not interfere with CSRF_TOKEN_MISMATCH 403 responses", async () => {
    const fetch = mockAuthMeFetch(401);
    await handlePossibleSessionExpiry(makeResponse(403), "/api/vouchers", fetch);
    expect(redirectTarget).toBeNull();
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });
});
