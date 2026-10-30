/**
 * Maersk's official Track & Trace API: the OAuth token cache and refresh,
 * token invalidation on 401/403, the response shapes, event ordering and each
 * ETA source in priority order. fetch is stubbed; the module is reloaded per
 * test so the token cache starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Track = typeof import("../server/lib/trackingProviders/maerskProvider").track;
let track: Track;
const fetchMock = vi.fn();
const env = { ...process.env };

const token = (expiresIn?: number) =>
  new Response(JSON.stringify({ access_token: "tok", ...(expiresIn === undefined ? {} : { expires_in: expiresIn }) }), {
    status: 200,
  });
const body = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

beforeEach(async () => {
  vi.resetModules();
  process.env.MAERSK_CONSUMER_KEY = "key";
  process.env.MAERSK_CONSUMER_SECRET = "secret";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  ({ track } = await import("../server/lib/trackingProviders/maerskProvider"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.env = { ...env };
});

async function api(value: unknown) {
  fetchMock.mockImplementation(async (url: string) => (url.includes("oauth2") ? token() : body(value)));
  return track("MSKU1234567");
}

describe("maersk API track", () => {
  it("is not configured without both credentials", async () => {
    delete process.env.MAERSK_CONSUMER_SECRET;
    const { track: unconfigured, isConfigured } = await import("../server/lib/trackingProviders/maerskProvider");
    expect(isConfigured()).toBe(false);
    expect(await unconfigured("MSKU1234567")).toMatchObject({
      success: false,
      notConfigured: true,
      error: "maersk_not_configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gets a token, calls the API with it and maps the newest event", async () => {
    const result = await api([
      {
        events: [
          { eventDate: "2026-10-10T00:00:00Z", eventCode: "GTIN", portName: "Durban" },
          {
            eventDateTime: "2026-10-15T00:00:00Z",
            transportEventTypeCode: "DEPA",
            location: { locationName: "Durban Port" },
            description: "Departed",
          },
          { date: "bad", eventType: "PLANNED", location: { UNLocationCode: "NAWVB" }, eventDescription: "Planned" },
          { status: null },
          { date: null, status: "ARRI", locationName: "Walvis Bay" },
        ],
        location: { locationName: "Current place" },
        eta: "2026-11-02",
      },
    ]);
    expect(result).toMatchObject({
      success: true,
      provider: "maersk",
      latestStatus: "DEPA",
      latestLocation: "Current place",
      latestDescription: "Departed",
      latestEventDate: new Date("2026-10-15T00:00:00Z"),
      eta: "2026-11-02",
    });
    expect(result.events.map((e) => [e.status, e.location])).toEqual([
      ["DEPA", "Durban Port"],
      ["GTIN", "Durban"],
      ["PLANNED", "NAWVB"],
      ["ARRI", "Walvis Bay"],
    ]);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe("https://api.maersk.com/oauth2/access_token");
    expect(tokenInit.body).toBe("grant_type=client_credentials&client_id=key&client_secret=secret");
    const [trackUrl, trackInit] = fetchMock.mock.calls[1];
    expect(trackUrl).toBe("https://api.maersk.com/track/MSKU1234567");
    expect(trackInit.headers).toMatchObject({ Authorization: "Bearer tok", "Consumer-Key": "key" });
  });

  it("reuses a token until a minute before it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    fetchMock.mockResolvedValueOnce(token(120)).mockResolvedValueOnce(body({ status: "A" }));
    await track("MSKU1234567");
    fetchMock.mockResolvedValueOnce(body({ status: "B" }));
    vi.setSystemTime(new Date("2026-10-20T00:00:59Z"));
    expect((await track("MSKU1234567")).latestStatus).toBe("B");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(new Date("2026-10-20T00:01:00Z"));
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(body({ status: "C" }));
    expect((await track("MSKU1234567")).latestStatus).toBe("C");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // The default lifetime is an hour.
    vi.setSystemTime(new Date("2026-10-20T00:59:00Z"));
    fetchMock.mockResolvedValueOnce(body({ status: "D" }));
    expect((await track("MSKU1234567")).latestStatus).toBe("D");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("drops the cached token after a 401 or 403 and reports the error", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response("denied", { status }));
      expect(await track("MSKU1234567")).toMatchObject({ success: false, error: `Maersk API HTTP ${status}: denied` });
    }
    expect(fetchMock).toHaveBeenCalledTimes(4);
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(new Response("busy", { status: 500 }));
    expect((await track("MSKU1234567")).error).toBe("Maersk API HTTP 500: busy");
    fetchMock.mockResolvedValueOnce(body({ status: "OK" }));
    expect((await track("MSKU1234567")).success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("reports token, empty-response and network failures", async () => {
    fetchMock.mockResolvedValueOnce(new Response("bad key", { status: 401 }));
    expect((await track("MSKU1234567")).error).toBe("Maersk OAuth 401: bad key");
    fetchMock.mockResolvedValueOnce(token()).mockResolvedValueOnce(body([]));
    expect((await track("MSKU1234567")).error).toBe("Maersk returned empty response");
    fetchMock.mockRejectedValueOnce("");
    expect((await track("MSKU1234567")).error).toBe("Unexpected server error");
  });

  it("finds status and events in nested container shapes", async () => {
    expect(
      await api({
        containers: [{ status: "IN TRANSIT", events: [{ eventDate: "2026-10-01T00:00:00Z", eventCode: "LOAD" }] }],
      })
    ).toMatchObject({
      latestStatus: "IN TRANSIT",
      latestLocation: null,
      events: [expect.objectContaining({ status: "LOAD" })],
    });
    expect(await api({ ContainerStatus: [{ Status: "DISCHARGED", events: [{ status: "DISC" }] }] })).toMatchObject({
      latestStatus: "DISCHARGED",
      latestEventDate: null,
    });
    expect(await api({ latestStatus: "TOP", status: "LOW" })).toMatchObject({
      latestStatus: "TOP",
      events: [],
      latestDescription: null,
    });
    expect((await api({ events: [{ eventCode: "X", location: { locationName: "L" } }] })).latestStatus).toBe("X");
    expect(await api({ events: "none" })).toMatchObject({ latestStatus: null, events: [] });
  });

  it("takes the ETA from the first source that has one", async () => {
    const cases: Array<[unknown, string | null]> = [
      [
        {
          portCalls: [
            { eta: "2026-01-01" },
            { isDestination: "true", estimatedArrival: "2026-11-02" },
            { eta: "2026-12-01" },
          ],
        },
        "2026-11-02",
      ],
      [{ portCalls: [{ eta: "2026-01-01" }, { estimatedTimeOfArrival: "2026-11-03" }] }, "2026-11-03"],
      [{ portCalls: [{ isDestination: true, eta: "2026-11-04" }] }, "2026-11-04"],
      [{ portOfDischarge: { eta: "2026-11-05" } }, "2026-11-05"],
      [{ portOfDischarge: { estimatedArrival: "2026-11-06" } }, "2026-11-06"],
      [{ portOfDischarge: { estimatedTimeOfArrival: "2026-11-07" } }, "2026-11-07"],
      [{ portOfDischarge: "Durban", estimatedArrival: "2026-11-08" }, "2026-11-08"],
      [{ estimatedTimeOfArrival: "2026-11-09" }, "2026-11-09"],
      [{ estimatedDelivery: "2026-11-10" }, "2026-11-10"],
      [{ containers: [{ eta: "2026-11-11" }] }, "2026-11-11"],
      [{ eta: "soon", containers: [{ eta: "2026-11-12" }] }, "2026-11-12"],
      [{ eta: 12345 }, null],
      [{ portCalls: "x" }, null],
    ];
    for (const [value, eta] of cases) {
      expect([value, (await api(value)).eta]).toEqual([value, eta]);
    }
  });
});
