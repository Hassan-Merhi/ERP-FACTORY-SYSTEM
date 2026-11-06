/**
 * Plan batch 5 (decision 10): while a tab is a read-only cold-start viewer,
 * the global fetch interceptor (client/src/lib/queryClient.ts) refuses every
 * write with HTTP 423 before it reaches any network. Signing in and out still
 * go through, and reads are unaffected. Driven through window.fetch, the way
 * the app calls it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OFFLINE_MODE_ENABLED: true,
}));

const realFetch = window.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
  delete (window as any).__csrfFetchPatched;
  window.history.replaceState({}, "", "/dashboard");
});

afterEach(() => {
  window.fetch = realFetch;
  delete (window as any).__csrfFetchPatched;
  window.history.replaceState({}, "", "/");
  vi.restoreAllMocks();
});

describe("Read-only cold start: every write is refused locally", () => {
  it("answers writes with 423 and lets reads, sign-in and sign-out reach the network", async () => {
    const network = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input).split("?")[0];
      if (path === "/api/csrf-token") return json({ csrfToken: "t" });
      return json({ ok: true });
    });
    window.fetch = network as unknown as typeof fetch;
    await import("@/lib/queryClient");
    const state = await import("@/lib/offline/coldStartState");
    state.setColdStartReadOnlyUntil(Date.now() + 60_000);

    for (const [method, url] of [
      ["POST", "/api/vouchers/payment-receipt"],
      ["PATCH", "/api/stock-items/4"],
      ["DELETE", "/api/vouchers/9"],
      ["PUT", "/api/stock-transfers/3"],
    ]) {
      const refused = await window.fetch(url, { method, body: "{}" });
      expect(refused.status, `${method} ${url}`).toBe(423);
      expect(await refused.json()).toMatchObject({ code: "OFFLINE_COLD_START_READ_ONLY" });
    }
    const sentPaths = () => network.mock.calls.map(([input]) => String(input).split("?")[0]);
    expect(sentPaths().filter((path) => path !== "/api/csrf-token")).toEqual([]);

    expect((await window.fetch("/api/locations")).status).toBe(200);
    expect((await window.fetch("/api/auth/login", { method: "POST", body: "{}" })).status).toBe(200);
    expect(sentPaths()).toContain("/api/locations");
    expect(sentPaths()).toContain("/api/auth/login");

    // Once the read-only window ends, writes go out again.
    state.setColdStartReadOnlyUntil(null);
    expect((await window.fetch("/api/stock-items/4", { method: "PATCH", body: "{}" })).status).toBe(200);
  });
});
