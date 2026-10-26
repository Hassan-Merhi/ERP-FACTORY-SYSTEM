/**
 * Maersk's public tracking endpoint: the cookie prefetch, every blocked or
 * malformed response, the event mapping and each ETA source in priority
 * order, including the deep scan. fetch is stubbed; the module is reloaded per
 * test so its in-process rate limit starts empty.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Track = typeof import("../server/lib/trackingProviders/maerskPublicProvider").track;
let track: Track;
let info: ReturnType<typeof vi.fn>;
const fetchMock = vi.fn();

const page = (cookie: string | null = "a=1; Path=/, b=2; Expires=Wed, 21 Oct 2026 07:28:00 GMT") =>
  new Response("<html></html>", { status: 200, headers: cookie ? { "set-cookie": cookie } : {} });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

beforeEach(async () => {
  vi.resetModules();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  const { logger } = await import("../server/lib/logger");
  info = vi.spyOn(logger, "info").mockImplementation(() => logger) as never;
  ({ track } = await import("../server/lib/trackingProviders/maerskPublicProvider"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function api(body: unknown, container = "MSKU1234567") {
  fetchMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(json(body));
  return track(container);
}

describe("maersk public track", () => {
  it("prefetches cookies, sends them to the API and maps the newest event", async () => {
    const outcome = await api({
      containers: [
        {
          events: [
            { eventDateTime: "2026-10-10T08:00:00Z", activityName: "GATE-IN", location: { portName: "Durban" } },
            {
              eventDate: "2026-10-15T08:00:00Z",
              transportEventTypeCode: "DEPA",
              location: { locationName: "Durban Terminal" },
              description: "Vessel departed",
            },
            { timestamp: "not-a-date", status: "PLANNED", portName: "Walvis Bay" },
            { date: null, eventCode: null, locationName: "Nowhere" },
          ],
          portCalls: [
            { eta: "2026-09-01" },
            { isDestination: "true", estimatedArrival: "2026-11-02T00:00:00Z" },
            { eta: "2026-12-01" },
          ],
        },
      ],
    });
    expect(outcome).toMatchObject({
      success: true,
      provider: "maersk_public",
      carrier: "MAERSK",
      latestStatus: "DEPA",
      latestLocation: "Durban Terminal",
      latestDescription: "Vessel departed",
      latestEventDate: new Date("2026-10-15T08:00:00Z"),
      eta: "2026-11-02",
    });
    expect(outcome.events.map((e) => [e.status, e.location, e.description])).toEqual([
      ["DEPA", "Durban Terminal", "Vessel departed"],
      ["GATE-IN", "Durban", "GATE-IN"],
      ["PLANNED", "Walvis Bay", null],
    ]);
    const [pageUrl, pageInit] = fetchMock.mock.calls[0];
    expect(pageUrl).toBe("https://www.maersk.com/tracking/MSKU1234567");
    expect(pageInit.headers.Accept).toContain("text/html");
    const [apiUrl, apiInit] = fetchMock.mock.calls[1];
    expect(apiUrl).toBe("https://www.maersk.com/api/tracking/MSKU1234567");
    expect(apiInit.headers).toMatchObject({ Cookie: "a=1; b=2", Origin: "https://www.maersk.com" });
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU1234567: prefetch done — cookies acquired");
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU1234567: success — status=DEPA events=3 eta=2026-11-02");
  });

  it("calls the API without cookies when the prefetch gives none or fails", async () => {
    fetchMock.mockResolvedValueOnce(page(null)).mockResolvedValueOnce(json({ eta: "2026-11-01" }));
    expect(await track("MSKU0000001")).toMatchObject({ success: true, eta: "2026-11-01", latestStatus: null });
    expect(fetchMock.mock.calls[1][1].headers.Cookie).toBeUndefined();
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU0000001: prefetch done — no cookies");

    fetchMock.mockRejectedValueOnce(new Error("reset")).mockResolvedValueOnce(json({ eta: "2026-11-01" }));
    expect((await track("MSKU0000002")).success).toBe(true);
    expect(fetchMock.mock.calls[3][1].headers.Cookie).toBeUndefined();
  });

  it("skips a container tried within the last six hours", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    await api({ eta: "2026-11-01" });
    expect(await track("MSKU1234567")).toMatchObject({ success: false, error: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU1234567: rate-limited — skipping");
    vi.setSystemTime(new Date("2026-10-20T06:00:00Z"));
    expect((await api({ eta: "2026-11-01" })).success).toBe(true);
  });

  it("reports blocked, failed, non-JSON and challenge responses", async () => {
    for (const status of [403, 401, 429]) {
      fetchMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response("", { status }));
      expect(await track(`MSKU00000${status}`)).toMatchObject({
        success: false,
        blocked: true,
        error: `blocked_http_${status}`,
      });
    }
    fetchMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response("", { status: 500 }));
    expect(await track("MSKU0000500")).toMatchObject({ success: false, error: "http_500" });
    expect((await track("MSKU0000500")).error).toBe("rate_limited");

    fetchMock
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce(
        new Response("<html>Please solve the DataDome captcha</html>", { headers: { "content-type": "text/html" } })
      );
    expect(await track("MSKU0000601")).toMatchObject({ blocked: true, error: "captcha_challenge" });
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU0000601: non-JSON response (bot challenge)");
    fetchMock.mockResolvedValueOnce(page()).mockResolvedValueOnce(new Response("plain text"));
    expect(await track("MSKU0000602")).toMatchObject({ blocked: false, error: "non_json_response" });
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU0000602: non-JSON response");
  });

  it("reports a timeout and any other request error", async () => {
    for (const name of ["TimeoutError", "AbortError"]) {
      fetchMock.mockResolvedValueOnce(page()).mockRejectedValueOnce(Object.assign(new Error("slow"), { name }));
      expect(await track(`MSKU${name.length}000001`)).toMatchObject({ success: false, error: "timeout" });
    }
    fetchMock.mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error("ECONNRESET"));
    expect(await track("MSKU0000701")).toMatchObject({ success: false, error: "ECONNRESET" });
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU0000701: ECONNRESET");
  });

  it("reports empty and unusable bodies as no data", async () => {
    expect(await api(null, "MSKU0000801")).toMatchObject({ noData: true, error: "empty_response" });
    expect(await api("text", "MSKU0000802")).toMatchObject({ noData: true, error: "empty_response" });
    const empty = await api({ containers: [{ events: [{ foo: 1 }] }] }, "MSKU0000803");
    expect(empty).toMatchObject({
      noData: true,
      error: "no_useful_data",
      raw: { containers: [{ events: [{ foo: 1 }] }] },
    });
    expect(info).toHaveBeenCalledWith("[MaerskPublic] MSKU0000803: response parseable but no useful data");
  });

  it("falls back to the entry's own status when no event has one", async () => {
    expect(await api({ shipment: { status: "IN TRANSIT", eta: "2026-11-01" } }, "MSKU0000901")).toMatchObject({
      latestStatus: "IN TRANSIT",
      latestLocation: null,
      latestEventDate: null,
    });
    expect(
      (await api({ trackingData: { latestStatus: "ARRIVED", eta: "2026-11-01" } }, "MSKU0000902")).latestStatus
    ).toBe("ARRIVED");
    expect((await api([{ eta: "2026-11-01" }], "MSKU0000903")).latestStatus).toBeNull();
  });

  it("finds events in each supported place", async () => {
    const event = { eventDateTime: "2026-10-15T08:00:00Z", status: "LOAD" };
    for (const [n, body] of [
      [1, { events: [event] }],
      [2, { shipment: { containers: [{ events: [event] }] } }],
      [3, { trackingData: { milestones: [event] } }],
      [4, { trackingData: {}, events: [event] }],
      [5, { events: "not-a-list", eta: "2026-11-01" }],
    ] as const) {
      const outcome = await api(body, `MSKU100000${n}`);
      expect(outcome.success).toBe(true);
      expect(outcome.latestStatus).toBe(n === 5 ? null : "LOAD");
    }
  });

  it("takes the ETA from the first source that has one", async () => {
    const sources: Array<[string, unknown]> = [
      ["destination port call eta", { portCalls: [{ isDestination: true, eta: "2026-11-01" }] }],
      ["destination estimatedArrival", { portCalls: [{ isDestination: true, estimatedArrival: "2026-11-02" }] }],
      ["destination estimatedTimeOfArrival", { portCalls: [{ estimatedTimeOfArrival: "2026-11-03" }] }],
      ["discharge eta", { portOfDischarge: { eta: "2026-11-04" } }],
      ["discharge estimatedArrival", { portOfDischarge: { estimatedArrival: "2026-11-05" } }],
      ["discharge estimatedTimeOfArrival", { portOfDischarge: { estimatedTimeOfArrival: "2026-11-06" } }],
      ["entry eta", { shipment: { eta: "2026-11-07" } }],
      ["entry estimatedTimeOfArrival", { shipment: { estimatedTimeOfArrival: "2026-11-08" } }],
      ["entry estimatedArrival", { shipment: { estimatedArrival: "2026-11-09" } }],
      ["entry plannedArrivalDate", { shipment: { plannedArrivalDate: "2026-11-10" } }],
      ["entry predictedETA", { shipment: { predictedETA: "2026-11-11" } }],
      ["entry latestEstimatedArrival", { shipment: { latestEstimatedArrival: "2026-11-12" } }],
      ["entry scheduledArrival", { shipment: { scheduledArrival: "2026-11-13" } }],
      ["last leg eta", { legs: [{ eta: "2026-01-01" }, { eta: "2026-11-14" }] }],
      ["last leg estimatedArrival", { legs: [{ estimatedArrival: "2026-11-15" }] }],
      ["first container eta", { shipment: { containers: [{ eta: "2026-11-16" }] } }],
      ["top-level estimatedTimeOfArrival", { shipment: {}, estimatedTimeOfArrival: "2026-11-17" }],
    ];
    let n = 0;
    for (const [label, body] of sources) {
      const outcome = await api(body, `MSKU2${String(++n).padStart(6, "0")}`);
      expect([label, outcome.eta]).toEqual([label, `2026-11-${String(n).padStart(2, "0")}`]);
    }
    // Without a destination flag the last port call is the destination; the first is the origin.
    expect((await api({ portCalls: [{ eta: "2026-09-01" }, { eta: "2026-12-02" }] }, "MSKU3000003")).eta).toBe(
      "2026-12-02"
    );
    // A shipment-level ETA wins over the top-level one.
    expect((await api({ shipment: { eta: "2026-12-01" }, eta: "2026-12-31" }, "MSKU3000001")).eta).toBe("2026-12-01");
    // An unparseable direct ETA is ignored.
    expect((await api({ eta: "soon", events: [{ status: "X" }] }, "MSKU3000002")).eta).toBeNull();
  });

  it("deep-scans the response for an ETA the known paths missed", async () => {
    const deep = await api(
      {
        shipment: { routing: [{ legs: "x" }, { stop: { vesselArrival: "2026-11-20T10:00:00Z" } }], status: "SAILING" },
      },
      "MSKU4000001"
    );
    expect(deep).toMatchObject({ success: true, eta: "2026-11-20", latestStatus: "SAILING" });
    expect(info).toHaveBeenCalledWith(
      "[MaerskPublic] MSKU4000001: ETA from deep-scan path=vesselArrival val=2026-11-20"
    );
    expect(info).toHaveBeenCalledWith(
      "[MaerskPublic] MSKU4000001: success — status=? events=0 eta=2026-11-20 (deep-scan path=vesselArrival)"
    );

    // Blank or unparseable ETA-named values are skipped; the scan continues.
    const skipped = await api(
      { shipment: { a: { arrivalDate: "  " }, b: { portArrival: "later" }, c: [{ ETA: "2026-11-21" }] } },
      "MSKU4000002"
    );
    expect(skipped.eta).toBe("2026-11-21");

    // The scan stops beyond twelve levels.
    let nested: Record<string, unknown> = { eta: "2026-11-22" };
    for (let i = 0; i < 12; i++) nested = { next: nested };
    expect(await api({ shipment: nested }, "MSKU4000003")).toMatchObject({ noData: true, error: "no_useful_data" });
    nested = { eta: "2026-11-22" };
    for (let i = 0; i < 11; i++) nested = { next: nested };
    expect((await api({ shipment: nested }, "MSKU4000004")).eta).toBe("2026-11-22");
  });

  it("encodes the container number in both requests", async () => {
    await api({ eta: "2026-11-01" }, "MSKU 1/2");
    expect(fetchMock.mock.calls[0][0]).toBe("https://www.maersk.com/tracking/MSKU%201%2F2");
    expect(fetchMock.mock.calls[1][0]).toBe("https://www.maersk.com/api/tracking/MSKU%201%2F2");
  });
});
