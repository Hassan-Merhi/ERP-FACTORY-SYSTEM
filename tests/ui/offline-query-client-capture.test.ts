/**
 * Standalone browser offline mode: the global request path (apiRequest in
 * client/src/lib/queryClient.ts) hands a write to the offline capture only
 * when the app already knew it was offline before sending. Reads, and writes
 * while the connection is up, go to the network as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/featureFlags", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  OFFLINE_MODE_ENABLED: true,
}));

const capture = vi.fn(async () => {
  const error = new Error("OFFLINE_SAVED_ON_DEVICE");
  error.name = "OfflineQueued";
  throw error;
});

vi.mock("@/lib/offline/browserCapture", () => ({ captureOfflineWriteForSignedInUser: capture }));

const realFetch = window.fetch;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.resetModules();
  capture.mockClear();
  delete (window as any).__csrfFetchPatched;
});

afterEach(async () => {
  (await import("@/lib/offline/connectivityState")).setKnownOffline(false);
  window.fetch = realFetch;
  delete (window as any).__csrfFetchPatched;
  vi.restoreAllMocks();
});

describe("apiRequest while known to be offline", () => {
  it("hands writes to the offline capture with the signed-in user, and sends nothing", async () => {
    const network = vi.fn(async () => json({ ok: true }));
    window.fetch = network as unknown as typeof fetch;
    const { apiRequest, queryClient } = await import("@/lib/queryClient");
    (await import("@/lib/offline/connectivityState")).setKnownOffline(true);
    queryClient.setQueryData(["/api/auth/me"], { id: "u-1" });

    const body = { stockItemId: 4, locationId: 2, type: "add", quantity: "3" };
    await expect(apiRequest("POST", "/api/inventory/quick-adjust", body)).rejects.toMatchObject({
      name: "OfflineQueued",
    });
    await expect(apiRequest("patch", "/api/stock-items/4", {})).rejects.toMatchObject({ name: "OfflineQueued" });
    expect(capture).toHaveBeenNthCalledWith(1, { id: "u-1" }, "POST", "/api/inventory/quick-adjust", body);
    expect(capture).toHaveBeenNthCalledWith(2, { id: "u-1" }, "patch", "/api/stock-items/4", {});
    expect(network.mock.calls.map(([input]) => String(input))).not.toContain("/api/inventory/quick-adjust");
  });

  it("sends reads, and writes while the connection is up, to the network", async () => {
    const network = vi.fn(async () => json({ ok: true }));
    window.fetch = network as unknown as typeof fetch;
    const { apiRequest } = await import("@/lib/queryClient");
    const connectivity = await import("@/lib/offline/connectivityState");

    connectivity.setKnownOffline(true);
    expect((await apiRequest("GET", "/api/locations")).status).toBe(200);
    connectivity.setKnownOffline(false);
    expect((await apiRequest("POST", "/api/inventory/quick-adjust", {})).status).toBe(200);
    expect(capture).not.toHaveBeenCalled();
  });
});
