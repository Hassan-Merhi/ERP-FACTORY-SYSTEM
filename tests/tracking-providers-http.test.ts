import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200, contentType = "application/json") =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": contentType },
  });
const env = { ...process.env };

let cmaApi: typeof import("../server/lib/trackingProviders/cmaCgmApiProvider");
let cmaPublic: typeof import("../server/lib/trackingProviders/cmaPublicProvider");
let seventeen: typeof import("../server/lib/trackingProviders/seventeenTrackProvider");
let logger: typeof import("../server/lib/logger").logger;

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  cmaApi = await import("../server/lib/trackingProviders/cmaCgmApiProvider");
  cmaPublic = await import("../server/lib/trackingProviders/cmaPublicProvider");
  seventeen = await import("../server/lib/trackingProviders/seventeenTrackProvider");
  logger = (await import("../server/lib/logger")).logger;
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...env };
});

describe("CMA CGM official API", () => {
  const event = (over: Record<string, unknown>) => ({
    eventType: "TRANSPORT",
    eventID: "e",
    eventCreatedDateTime: "2026-10-01T00:00:00Z",
    eventClassifierCode: "ACT",
    eventDateTime: "2026-10-01T00:00:00Z",
    ...over,
  });

  it("needs an API key", async () => {
    delete process.env.CMA_CGM_API_KEY;
    expect(cmaApi.isConfigured()).toBe(false);
    await expect(cmaApi.track("CMAU1")).resolves.toMatchObject({
      success: false,
      provider: "cma_cgm_api",
      carrier: "CMA",
      notConfigured: true,
      error: "CMA_CGM_API_KEY not set",
    });
  });

  it("parses DCSA events, the POD arrival ETA and the latest actual move", async () => {
    process.env.CMA_CGM_API_KEY = "key";
    expect(cmaApi.isConfigured()).toBe(true);
    const events = [
      event({
        eventClassifierCode: "PLN",
        transportEventTypeCode: "ARRI",
        eventDateTime: "2026-11-02T06:00:00Z",
        carrierSpecificData: { shipmentLocationType: "POL" },
      }),
      event({
        eventClassifierCode: "PLN",
        transportEventTypeCode: "ARRI",
        eventDateTime: "2026-11-05T06:00:00Z",
        carrierSpecificData: { shipmentLocationType: "POD" },
        transportCall: { location: { locationName: "Walvis Bay" } },
      }),
      event({
        eventDateTime: "2026-10-10T08:00:00Z",
        transportEventTypeCode: "DEPA",
        carrierSpecificData: { internalEventLabel: "Vessel Departure" },
        transportCall: {
          location: { locationName: "Shanghai" },
          vessel: { vesselName: "CMA X" },
          exportVoyageNumber: "0AB1",
        },
      }),
      event({
        eventType: "EQUIPMENT",
        equipmentEventTypeCode: "GTIN",
        eventDateTime: "2026-10-05T08:00:00Z",
        transportCall: { location: { UNLocationCode: "CNSHA" } },
      }),
      event({ eventClassifierCode: "EST", eventDateTime: "not a date" }),
    ];
    fetchMock.mockResolvedValueOnce(json(events));
    const result = await cmaApi.track("CMAU 1");
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://apis.cma-cgm.net/operation/trackandtrace/v1/events?equipmentReference=CMAU%201"
    );
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ keyId: "key", Accept: "application/json" });
    expect(result).toMatchObject({
      success: true,
      eta: "2026-11-05",
      latestStatus: "Vessel Departure",
      latestLocation: "Shanghai",
      latestEventDate: new Date("2026-10-10T08:00:00Z"),
      latestDescription: "Vessel Departure, CMA X, voyage 0AB1",
      raw: events,
    });
    expect(result.events.map((e) => [e.status, e.location])).toEqual([
      ["ARRI", "Walvis Bay"],
      ["ARRI", null],
      ["Vessel Departure", "Shanghai"],
      ["GTIN", "CNSHA"],
    ]);
  });

  it("falls back to the newest event when there is no actual move", async () => {
    process.env.CMA_CGM_API_KEY = "key";
    fetchMock.mockResolvedValueOnce(
      json([
        event({
          eventClassifierCode: "EST",
          eventType: "SHIPMENT",
          eventDateTime: "2026-10-12T00:00:00Z",
          transportCall: { importVoyageNumber: "9" },
        }),
      ])
    );
    await expect(cmaApi.track("CMAU2")).resolves.toMatchObject({
      success: true,
      eta: null,
      latestStatus: "SHIPMENT",
      latestLocation: null,
      latestEventDate: new Date("2026-10-12T00:00:00Z"),
      latestDescription: "SHIPMENT",
    });

    fetchMock.mockResolvedValueOnce(json([event({ eventClassifierCode: "EST", eventDateTime: "bad" })]));
    await expect(cmaApi.track("CMAU2")).resolves.toMatchObject({
      success: true,
      latestStatus: null,
      latestEventDate: null,
      latestDescription: null,
    });
  });

  it("maps HTTP failures, empty responses and network errors", async () => {
    process.env.CMA_CGM_API_KEY = "key";
    fetchMock.mockResolvedValueOnce(new Response("", { status: 404 }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ noData: true, error: "not_found" });
    fetchMock.mockResolvedValueOnce(new Response("upstream down", { status: 502 }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "http_502" });
    fetchMock.mockResolvedValueOnce(json([]));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ noData: true, error: "no_events" });
    fetchMock.mockResolvedValueOnce(json({ events: [] }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "no_events" });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("slow"), { name: "TimeoutError" }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "timeout" });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "timeout" });
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "ECONNRESET" });
  });

  it("pauses for 15 minutes after an authentication failure", async () => {
    process.env.CMA_CGM_API_KEY = "key";
    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ blocked: true, error: "auth_401" });
    await expect(cmaApi.track("C")).resolves.toMatchObject({ blocked: true, error: "auth_401_cooldown" });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-10-20T12:15:01Z"));
    fetchMock.mockResolvedValueOnce(new Response("", { status: 403 }));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "auth_403" });
    await expect(cmaApi.track("C")).resolves.toMatchObject({ error: "auth_403_cooldown" });

    // A successful call after the cooldown clears it.
    vi.setSystemTime(new Date("2026-10-20T12:31:00Z"));
    fetchMock.mockResolvedValueOnce(json([event({})]));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ success: true });
    fetchMock.mockResolvedValueOnce(json([event({})]));
    await expect(cmaApi.track("C")).resolves.toMatchObject({ success: true });
  });
});

describe("CMA CGM public tracking", () => {
  const enable = () => {
    process.env.PUBLIC_CARRIER_TRACKING_ENABLED = "TRUE";
    process.env.CMA_PUBLIC_TRACKING_ENABLED = "true";
  };

  it("is opt-in on both switches", async () => {
    delete process.env.PUBLIC_CARRIER_TRACKING_ENABLED;
    process.env.CMA_PUBLIC_TRACKING_ENABLED = "true";
    expect(cmaPublic.isEnabled()).toBe(false);
    process.env.PUBLIC_CARRIER_TRACKING_ENABLED = "true";
    process.env.CMA_PUBLIC_TRACKING_ENABLED = "no";
    expect(cmaPublic.isEnabled()).toBe(false);
    await expect(cmaPublic.track("C")).resolves.toMatchObject({
      provider: "cma_public",
      notConfigured: true,
      error: "cma_public_not_enabled",
    });
    enable();
    expect(cmaPublic.isEnabled()).toBe(true);
  });

  it("parses the shipment's events and ETA", async () => {
    enable();
    const body = {
      shipment: {
        eta: "2026-11-07T00:00:00Z",
        events: [
          {
            eventDateTime: "2026-10-01T00:00:00Z",
            typeCode: "LOAD",
            location: { portName: "Ningbo" },
            description: "Loaded",
          },
          { actualDate: "2026-10-09T00:00:00Z", eventCode: "DEP", locationName: "Ningbo T" },
          { timestamp: "2026-10-05T00:00:00Z", activityCode: "GATE", portName: "Ningbo P" },
          { date: null, status: "Planned", location: "Walvis Bay" },
          { date: "bad" },
        ],
      },
    };
    fetchMock.mockResolvedValueOnce(json(body));
    const result = await cmaPublic.track("CMAU 9");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.cma-cgm.com/ebusiness/tracking/json/CMAU%209");
    expect(result).toMatchObject({
      success: true,
      latestStatus: "DEP",
      latestLocation: "Ningbo T",
      latestEventDate: new Date("2026-10-09T00:00:00Z"),
      latestDescription: "DEP",
      eta: "2026-11-07",
      raw: body,
    });
    expect(result.events.map((e) => [e.status, e.location, e.description])).toEqual([
      ["DEP", "Ningbo T", "DEP"],
      ["GATE", "Ningbo P", null],
      ["LOAD", "Ningbo", "Loaded"],
      ["Planned", "Walvis Bay", null],
    ]);
  });

  it("reads the other response shapes", async () => {
    enable();
    fetchMock.mockResolvedValueOnce(json({ tracking: { milestones: [], predictedETA: "2026-12-01" } }));
    await expect(cmaPublic.track("A1")).resolves.toMatchObject({
      success: true,
      eta: "2026-12-01",
      latestStatus: null,
    });

    fetchMock.mockResolvedValueOnce(
      json({ shipments: [{ containerEvents: [{ date: "2026-10-01", status: "Discharged" }], statusCode: "DIS" }] })
    );
    await expect(cmaPublic.track("A2")).resolves.toMatchObject({ success: true, latestStatus: "Discharged" });

    fetchMock.mockResolvedValueOnce(json({ events: [{ date: "2026-10-03", typeCode: "ARR" }], eta: "2026-10-30" }));
    await expect(cmaPublic.track("A3")).resolves.toMatchObject({ latestStatus: "ARR", eta: "2026-10-30" });

    fetchMock.mockResolvedValueOnce(json({ shipment: { status: "IN_TRANSIT", estimatedArrivalDate: "2026-11-11" } }));
    await expect(cmaPublic.track("A4")).resolves.toMatchObject({ latestStatus: "IN_TRANSIT", eta: "2026-11-11" });

    fetchMock.mockResolvedValueOnce(json({ shipment: { estimatedTimeOfArrival: "nope" } }));
    await expect(cmaPublic.track("A5")).resolves.toMatchObject({ noData: true, error: "no_useful_data" });

    fetchMock.mockResolvedValueOnce(json("null"));
    await expect(cmaPublic.track("A6")).resolves.toMatchObject({ noData: true, error: "empty_response" });
  });

  it("detects blocking, non-JSON pages and errors", async () => {
    enable();
    for (const status of [401, 403, 429]) {
      fetchMock.mockResolvedValueOnce(new Response("", { status }));
      await expect(cmaPublic.track(`B${status}`)).resolves.toMatchObject({
        blocked: true,
        error: `blocked_http_${status}`,
      });
    }
    fetchMock.mockResolvedValueOnce(new Response("", { status: 500 }));
    await expect(cmaPublic.track("B500")).resolves.toMatchObject({ error: "http_500" });
    fetchMock.mockResolvedValueOnce(json("<html>Please complete the DataDome captcha</html>", 200, "text/html"));
    await expect(cmaPublic.track("B1")).resolves.toMatchObject({ blocked: true, error: "captcha_challenge" });
    fetchMock.mockResolvedValueOnce(json("<html>Maintenance</html>", 200, "text/html"));
    await expect(cmaPublic.track("B2")).resolves.toMatchObject({ blocked: false, error: "non_json_response" });
    fetchMock.mockResolvedValueOnce(json({ eta: "2026-11-01" }, 200, "text/javascript"));
    await expect(cmaPublic.track("B3")).resolves.toMatchObject({ success: true });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("t"), { name: "TimeoutError" }));
    await expect(cmaPublic.track("B4")).resolves.toMatchObject({ error: "timeout" });
    fetchMock.mockRejectedValueOnce(new Error("dns"));
    await expect(cmaPublic.track("B5")).resolves.toMatchObject({ error: "dns" });
  });

  it("tries each container at most once an hour", async () => {
    enable();
    fetchMock.mockImplementation(async () => json({ eta: "2026-11-01" }));
    await cmaPublic.track("R1");
    await expect(cmaPublic.track("R1")).resolves.toMatchObject({ error: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date("2026-10-20T13:00:01Z"));
    await expect(cmaPublic.track("R1")).resolves.toMatchObject({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the rate-limit memory", async () => {
    process.env.TRACKING_RATE_LIMIT_MAX_ENTRIES = "100";
    vi.resetModules();
    cmaPublic = await import("../server/lib/trackingProviders/cmaPublicProvider");
    enable();
    fetchMock.mockImplementation(async () => json({ eta: "2026-11-01" }));
    for (let i = 0; i <= 100; i++) await cmaPublic.track(`M${i}`);
    // The oldest entry was evicted, so it may be tried again within the hour.
    await expect(cmaPublic.track("M0")).resolves.toMatchObject({ success: true });
    await expect(cmaPublic.track("M100")).resolves.toMatchObject({ error: "rate_limited" });
  });
});

describe("17track", () => {
  const accepted = (trackInfo: Record<string, unknown>) => ({
    code: 0,
    data: { accepted: [{ number: "CMAU1", track_info: trackInfo }] },
  });

  async function run(carrier?: number) {
    const pending = seventeen.track("CMAU1", carrier);
    await vi.advanceTimersByTimeAsync(5_000);
    return pending;
  }

  it("needs an API key and reads the monthly limit", async () => {
    delete process.env.SEVENTEENTRACK_API_KEY;
    expect(seventeen.isConfigured()).toBe(false);
    await expect(seventeen.track("CMAU1")).resolves.toMatchObject({
      provider: "17track",
      notConfigured: true,
      error: "SEVENTEENTRACK_API_KEY not configured",
    });
    delete process.env.SEVENTEENTRACK_MONTHLY_LIMIT;
    expect(seventeen.getMonthlyLimit()).toBe(100);
    process.env.SEVENTEENTRACK_MONTHLY_LIMIT = "250";
    expect(seventeen.getMonthlyLimit()).toBe(250);
    process.env.SEVENTEENTRACK_MONTHLY_LIMIT = "-5";
    expect(seventeen.getMonthlyLimit()).toBe(1);
    process.env.SEVENTEENTRACK_MONTHLY_LIMIT = "abc";
    expect(seventeen.getMonthlyLimit()).toBe(100);
    expect(seventeen.CARRIER_CODES.CMA).toBe(100755);
  });

  it("registers, waits and reads the tracking info", async () => {
    process.env.SEVENTEENTRACK_API_KEY = "tok";
    const info = {
      latest_status: { status: "InTransit" },
      latest_event: { time_iso: "2026-10-15T10:00:00Z", description: "Departed", location: "Durban" },
      time_metrics: { estimated_delivery_date: { from: "2026-11-01T00:00:00Z", to: "2026-11-03T00:00:00Z" } },
      tracking: {
        providers: [
          {
            events: [
              {
                time_iso: "2026-10-15T10:00:00Z",
                sub_status: "InTransit_Departure",
                location: "Durban",
                description: "Departed",
              },
              { time_utc: "2026-10-10T10:00:00Z", stage: "PickedUp" },
              {},
            ],
          },
        ],
      },
    };
    fetchMock
      .mockResolvedValueOnce(json({ code: 0, data: { accepted: [] } }))
      .mockResolvedValueOnce(json(accepted(info)));
    const result = await run(100755);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://api.17track.net/track/v2.2/register",
      "https://api.17track.net/track/v2.2/gettrackinfo",
    ]);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual([{ number: "CMAU1", carrier: 100755 }]);
    expect(fetchMock.mock.calls[0][1].headers).toEqual({ "Content-Type": "application/json", "17token": "tok" });
    expect(result).toMatchObject({
      success: true,
      latestStatus: "InTransit",
      latestLocation: "Durban",
      latestEventDate: new Date("2026-10-15T10:00:00Z"),
      latestDescription: "Departed",
      eta: "2026-11-03",
    });
    expect(result.events).toEqual([
      {
        date: new Date("2026-10-15T10:00:00Z"),
        status: "InTransit_Departure",
        location: "Durban",
        description: "Departed",
      },
      { date: new Date("2026-10-10T10:00:00Z"), status: "PickedUp", location: null, description: null },
      { date: null, status: null, location: null, description: null },
    ]);
  });

  it("uses the ETA range start, or the delivery date for a delivered box", async () => {
    process.env.SEVENTEENTRACK_API_KEY = "tok";
    fetchMock
      .mockResolvedValueOnce(json({ code: 0 }))
      .mockResolvedValueOnce(
        json(accepted({ time_metrics: { estimated_delivery_date: { from: "2026-11-09", to: null } } }))
      );
    await expect(run()).resolves.toMatchObject({ eta: "2026-11-09", latestStatus: null, events: [] });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual([{ number: "CMAU1", carrier: 0 }]);

    fetchMock.mockResolvedValueOnce(json({ code: 0 })).mockResolvedValueOnce(
      json(
        accepted({
          latest_status: { status: "Delivered" },
          latest_event: { time_utc: "2026-10-18T09:00:00Z" },
          time_metrics: { estimated_delivery_date: { to: "garbage" } },
        })
      )
    );
    await expect(run()).resolves.toMatchObject({ eta: "2026-10-18" });

    fetchMock
      .mockResolvedValueOnce(json({ code: 0 }))
      .mockResolvedValueOnce(
        json(accepted({ latest_status: { status: "InTransit" }, latest_event: { time_iso: "2026-10-18" } }))
      );
    await expect(run()).resolves.toMatchObject({ eta: null });
  });

  it("reports rejections, missing data and API errors", async () => {
    process.env.SEVENTEENTRACK_API_KEY = "tok";
    fetchMock.mockResolvedValueOnce(
      json({
        code: 0,
        data: { rejected: [{ number: "CMAU1", error: { code: -18019901, message: "Carrier cannot be detected" } }] },
      })
    );
    await expect(seventeen.track("CMAU1")).resolves.toMatchObject({
      noData: true,
      error: "Carrier cannot be detected",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(json({ code: 0, data: { rejected: [{ number: "CMAU1" }] } }));
    await expect(seventeen.track("CMAU1")).resolves.toMatchObject({ error: "Rejected at register step" });

    fetchMock
      .mockResolvedValueOnce(
        json({ code: 0, data: { rejected: [{ number: "OTHER", error: { code: 1, message: "x" } }] } })
      )
      .mockResolvedValueOnce(
        json({ code: 0, data: { rejected: [{ number: "CMAU1", error: { code: 2, message: "Not found" } }] } })
      );
    await expect(run()).resolves.toMatchObject({ noData: true, error: "Not found" });

    fetchMock
      .mockResolvedValueOnce(json({ code: 0 }))
      .mockResolvedValueOnce(json({ code: 0, data: { rejected: [{ number: "CMAU1" }] } }));
    await expect(run()).resolves.toMatchObject({ error: "Rejected by 17track" });

    fetchMock
      .mockResolvedValueOnce(json({ code: 0 }))
      .mockResolvedValueOnce(json({ code: 0, data: { accepted: [{ number: "CMAU1" }] } }));
    await expect(run()).resolves.toMatchObject({ noData: true, error: "No tracking data returned by 17track" });

    fetchMock.mockResolvedValueOnce(json({ code: 0 })).mockResolvedValueOnce(json({ code: -1 }));
    await expect(run()).resolves.toMatchObject({ success: false, error: "17track API error code -1" });

    fetchMock.mockResolvedValueOnce(new Response("", { status: 401 }));
    await expect(run()).resolves.toMatchObject({ error: "17track register HTTP 401" });

    fetchMock.mockResolvedValueOnce(json({ code: 0 })).mockResolvedValueOnce(new Response("", { status: 503 }));
    await expect(run()).resolves.toMatchObject({ error: "17track gettrackinfo HTTP 503" });
  });
});
