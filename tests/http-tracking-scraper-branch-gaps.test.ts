import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../server/lib/logger", () => ({ logger }));

import { httpScrapeTracking, isHttpScraperAvailable } from "../server/lib/httpTrackingScraper";

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
    text: vi.fn().mockResolvedValue(JSON.stringify(body)),
  } as any;
}

describe("Phase 30 HTTP tracking scraper branch gaps", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is always available because it needs no credentials", () => {
    expect(isHttpScraperAvailable()).toBe(true);
  });

  it.each([
    ["MAEU1234567", "Maersk page: no tracking data in HTML"],
    ["CMAU1234567", "CMA page: DataDome protected, use ParcelsApp API"],
    ["YMLU1234567", "unknown carrier: forwarding to ParcelsApp API"],
    ["OOLU1234567", "unknown carrier: forwarding to ParcelsApp API"],
    ["ZZZZ1234567", "unknown carrier: forwarding to ParcelsApp API"],
  ])("fast-fails %s without a network request", async (containerNumber, error) => {
    await expect(httpScrapeTracking(containerNumber)).resolves.toMatchObject({ success: false, shipment: null, error });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the MSC HTTP status without attempting to parse an error response", async () => {
    fetchMock.mockResolvedValue(jsonResponse({}, 503));

    const result = await httpScrapeTracking("MSCU1234567");

    expect(result).toEqual({ success: false, shipment: null, error: "MSC HTTP 503" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://www.msc.com/api/feature/tools/tracing/get-trace-results",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("reports an MSC payload with no activities", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ TrackingDetails: { TrackingActivities: [] } }));

    await expect(httpScrapeTracking("MSDU1234567")).resolves.toEqual({
      success: false,
      shipment: null,
      error: "MSC: no activities",
    });
  });

  it("maps MSC primary fields and a dedicated ETA into a shipment", async () => {
    const body = {
      TrackingDetails: {
        ETA: "2026-10-01",
        TrackingActivities: [
          { ActivityDate: "2026-09-14", ActivityDescription: "Loaded", Location: "Durban" },
          { ActivityDate: "2026-09-13", ActivityDescription: "Gate in", Location: "Johannesburg" },
        ],
      },
    };
    fetchMock.mockResolvedValue(jsonResponse(body));

    const result = await httpScrapeTracking("MSMU1234567");

    expect(result.success).toBe(true);
    expect(result.shipment).toMatchObject({
      trackingId: "MSMU1234567",
      attributes: { status: "Loaded", location: "Durban", estimatedArrival: "2026-10-01" },
    });
    expect(result.shipment?.states).toHaveLength(2);
  });

  it("finds MSC ETA from an activity and accepts fallback activity field names", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        trackingActivities: [
          { date: "2026-09-14", description: "Sailed", location: "Cape Town" },
          { date: "2026-10-02", description: "Estimated Arrival", location: "Beira" },
        ],
      })
    );

    const result = await httpScrapeTracking("MSWU1234567");

    expect(result.success).toBe(true);
    expect(result.shipment?.attributes).toMatchObject({
      status: "Sailed",
      location: "Cape Town",
      estimatedArrival: "2026-10-02",
    });
  });

  it("converts an MSC fetch exception into a typed failure", async () => {
    fetchMock.mockRejectedValue(new Error("socket closed"));

    await expect(httpScrapeTracking("MSCU7654321")).resolves.toMatchObject({
      success: false,
      shipment: null,
      error: "MSC: socket closed",
    });
  });

  it("maps Hapag container journeys and ETA", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        containerJourneys: [
          {
            eta: "2026-10-03",
            containerMoves: [
              { eventDateTime: "2026-09-14T10:00:00Z", transportModeDescription: "Vessel", portOfCall: "Durban" },
            ],
          },
        ],
      })
    );

    const result = await httpScrapeTracking("HLCU1234567");

    expect(result.success).toBe(true);
    expect(result.shipment).toMatchObject({
      trackingId: "HLCU1234567",
      attributes: { status: "Vessel", location: "Durban", estimatedArrival: "2026-10-03" },
    });
  });

  it("uses Hapag fallback move fields and reports missing moves", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ moves: [{ date: "2026-09-14", event: "Loaded", location: "Lusaka" }], eta: null })
      )
      .mockResolvedValueOnce(jsonResponse({ moves: [] }));

    const success = await httpScrapeTracking("HLXU1234567");
    const miss = await httpScrapeTracking("HLCU7654321");

    expect(success).toMatchObject({ success: true });
    expect(success.shipment?.attributes).toMatchObject({ status: "Loaded", location: "Lusaka" });
    expect(miss).toEqual({ success: false, shipment: null, error: "Hapag: no moves" });
  });

  it("maps COSCO content, movement activities and ETA", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: {
          content: [
            {
              estimatedArrivalDate: "2026-10-04",
              movementActivities: [{ eventDate: "2026-09-14", activity: "Departed", location: "Shanghai" }],
            },
          ],
        },
      })
    );

    const result = await httpScrapeTracking("COSU1234567");

    expect(result.success).toBe(true);
    expect(result.shipment?.attributes).toMatchObject({
      status: "Departed",
      location: "Shanghai",
      estimatedArrival: "2026-10-04",
    });
  });

  it("returns the COSCO no-data branch when content is absent", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ data: { content: [] } }));

    await expect(httpScrapeTracking("CBHU1234567")).resolves.toEqual({
      success: false,
      shipment: null,
      error: "COSCO: no data",
    });
  });

  it("maps Evergreen events and ETA", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        ETA: "2026-10-05",
        EventList: [{ EventDate: "2026-09-14", EventName: "Discharged", PortName: "Beira" }],
      })
    );

    const result = await httpScrapeTracking("EVRU1234567");

    expect(result.success).toBe(true);
    expect(result.shipment?.attributes).toMatchObject({
      status: "Discharged",
      location: "Beira",
      estimatedArrival: "2026-10-05",
    });
  });

  it("returns Evergreen HTTP and no-event failures deterministically", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429)).mockResolvedValueOnce(jsonResponse({ events: [] }));

    await expect(httpScrapeTracking("EVRG1234567")).resolves.toEqual({
      success: false,
      shipment: null,
      error: "Evergreen HTTP 429",
    });
    await expect(httpScrapeTracking("EMCU1234567")).resolves.toEqual({
      success: false,
      shipment: null,
      error: "Evergreen: no events",
    });
  });
});
