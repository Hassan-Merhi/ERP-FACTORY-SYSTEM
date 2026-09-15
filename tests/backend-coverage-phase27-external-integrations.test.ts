/**
 * Phase 27 — External integrations.
 *
 * Provider clients are tested at their network boundary so malformed payloads,
 * explicit provider errors, timeouts, and retry rules cannot turn into false
 * success or uncontrolled retry storms. No real external service is contacted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const VALID_CONTAINER = "MSKU1234567";
const originalEnv = {
  JSONCARGO_API_KEY: process.env.JSONCARGO_API_KEY,
  MAERSK_CONSUMER_KEY: process.env.MAERSK_CONSUMER_KEY,
  MAERSK_CONSUMER_SECRET: process.env.MAERSK_CONSUMER_SECRET,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();

  if (originalEnv.JSONCARGO_API_KEY === undefined) {
    delete process.env.JSONCARGO_API_KEY;
  } else {
    process.env.JSONCARGO_API_KEY = originalEnv.JSONCARGO_API_KEY;
  }
  if (originalEnv.MAERSK_CONSUMER_KEY === undefined) {
    delete process.env.MAERSK_CONSUMER_KEY;
  } else {
    process.env.MAERSK_CONSUMER_KEY = originalEnv.MAERSK_CONSUMER_KEY;
  }
  if (originalEnv.MAERSK_CONSUMER_SECRET === undefined) {
    delete process.env.MAERSK_CONSUMER_SECRET;
  } else {
    process.env.MAERSK_CONSUMER_SECRET = originalEnv.MAERSK_CONSUMER_SECRET;
  }
});

describe("Phase 27 JSONCargo provider", () => {
  it("rejects malformed 200 responses instead of reporting false success", async () => {
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    const result = await track(VALID_CONTAINER, "MAERSK");

    expect(result).toMatchObject({
      success: false,
      eta: null,
      errorCategory: "unexpected_response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid JSON body with the wrong provider shape", async () => {
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    const result = await track(VALID_CONTAINER, "MAERSK");

    expect(result.success).toBe(false);
    expect(result.errorCategory).toBe("unexpected_response");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries one transient 5xx and succeeds without exceeding the retry budget", async () => {
    vi.useFakeTimers();
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: "temporary" }, 503))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { eta_final_destination: "2026-10-05T08:00:00Z" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    const pending = track(VALID_CONTAINER, "MAERSK");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toEqual({
      success: true,
      eta: "2026-10-05",
      errorCategory: null,
      errorMessage: null,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic 400/404 provider responses", async () => {
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "missing" }, 404));
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    const result = await track(VALID_CONTAINER, "MAERSK");

    expect(result.errorCategory).toBe("not_found");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a timeout once, then returns a controlled timeout result", async () => {
    vi.useFakeTimers();
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const timeout = Object.assign(new Error("provider timeout"), {
      name: "TimeoutError",
    });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    const pending = track(VALID_CONTAINER, "MAERSK");
    await vi.runAllTimersAsync();
    const result = await pending;

    expect(result).toMatchObject({
      success: false,
      eta: null,
      errorCategory: "timeout",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refuses unsupported input before making a provider request", async () => {
    process.env.JSONCARGO_API_KEY = "phase27-key";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { track, normalizeJsonCargoCarrier } = await import(
      "../server/lib/trackingProviders/jsonCargoProvider"
    );
    expect(normalizeJsonCargoCarrier("CMA-CGM (France)")).toBe("CMA_CGM");
    expect(normalizeJsonCargoCarrier("unknown carrier")).toBeNull();

    const result = await track("BAD-CONTAINER", "MAERSK");
    expect(result.errorCategory).toBe("invalid_container_number");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Phase 27 Maersk provider", () => {
  it("fails closed without credentials and never contacts Maersk", async () => {
    delete process.env.MAERSK_CONSUMER_KEY;
    delete process.env.MAERSK_CONSUMER_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/maerskProvider"
    );
    const result = await track(VALID_CONTAINER);

    expect(result).toMatchObject({
      success: false,
      notConfigured: true,
      error: "maersk_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("turns malformed tracking JSON into a controlled provider failure", async () => {
    process.env.MAERSK_CONSUMER_KEY = "phase27-key";
    process.env.MAERSK_CONSUMER_SECRET = "phase27-secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "token-a", expires_in: 3600 })
      )
      .mockResolvedValueOnce(
        new Response("broken-json", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/maerskProvider"
    );
    const result = await track(VALID_CONTAINER);

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates an unauthorized token so the next safe tracking attempt re-authenticates", async () => {
    process.env.MAERSK_CONSUMER_KEY = "phase27-key";
    process.env.MAERSK_CONSUMER_SECRET = "phase27-secret";
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "token-a", expires_in: 3600 })
      )
      .mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, 401))
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "token-b", expires_in: 3600 })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: "IN_TRANSIT",
          portCalls: [
            { eta: "2026-09-20T00:00:00Z" },
            {
              isDestination: true,
              eta: "2026-10-11T00:00:00Z",
            },
          ],
          events: [
            {
              eventDateTime: "2026-09-14T12:00:00Z",
              status: "DEPARTED",
            },
          ],
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    const { track } = await import(
      "../server/lib/trackingProviders/maerskProvider"
    );
    const first = await track(VALID_CONTAINER);
    const second = await track(VALID_CONTAINER);

    expect(first.success).toBe(false);
    expect(first.error).toMatch(/401/);
    expect(second).toMatchObject({
      success: true,
      eta: "2026-10-11",
      latestStatus: "IN_TRANSIT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe("Phase 27 WhatsApp provider boundary", () => {
  it("normalizes recipient ids without changing existing group ids", async () => {
    const { normaliseChatId } = await import(
      "../server/services/whatsappService"
    );
    expect(normaliseChatId("+243 999 123 456")).toBe("243999123456@c.us");
    expect(normaliseChatId("120363000000@g.us")).toBe(
      "120363000000@g.us"
    );
  });

  it("returns unknown instead of throwing on provider timeout", async () => {
    const timeout = Object.assign(new Error("timeout"), { name: "TimeoutError" });
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    vi.stubGlobal("fetch", fetchMock);

    const { getGreenInstanceState } = await import(
      "../server/services/whatsappService"
    );
    await expect(
      getGreenInstanceState("instance", "token")
    ).resolves.toBe("unknown");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats malformed provider JSON as an unknown connection state", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("not-json", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const { getGreenInstanceState } = await import(
      "../server/services/whatsappService"
    );
    await expect(
      getGreenInstanceState("instance", "token")
    ).resolves.toBe("unknown");
  });
});
