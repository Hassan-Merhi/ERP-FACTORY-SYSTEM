/**
 * httpTrackingScraper with sparse carrier payloads and failing transports:
 * fetch is stubbed (the carriers' public endpoints are the outbound boundary).
 * Pins the blank-field fallbacks, attribute omission for empty status /
 * location / ETA, HTTP refusals and thrown-transport errors for every carrier.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { httpScrapeTracking } from "../server/lib/httpTrackingScraper";

const fetchMock = vi.fn();
const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) });

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("sparse carrier payloads", () => {
  it("MSC: blank activities give empty events, no attributes and no ETA", async () => {
    fetchMock.mockResolvedValue(ok({ trackingActivities: [{}, { description: "Loaded" }] }));
    const r = await httpScrapeTracking("MSCU1234567");
    expect(r.success).toBe(true);
    expect(r.shipment).toEqual({
      trackingId: "MSCU1234567",
      done: true,
      attributes: {},
      states: [
        { date: "", status: "", location: "" },
        { date: "", status: "Loaded", location: "" },
      ],
    });
  });

  it("Hapag: blank moves give empty events and no attributes", async () => {
    fetchMock.mockResolvedValue(ok({ moves: [{}] }));
    const r = await httpScrapeTracking("HLCU1234567");
    expect(r.shipment).toMatchObject({ attributes: {}, states: [{ date: "", status: "", location: "" }] });
  });

  it("COSCO: a detail without moves succeeds with no events, blank moves give empty fields", async () => {
    fetchMock.mockResolvedValueOnce(ok({ data: { content: [{ eta: "2026-12-01" }] } }));
    const bare = await httpScrapeTracking("COSU1234567");
    expect(bare.shipment).toMatchObject({ attributes: { estimatedArrival: "2026-12-01" }, states: [] });
    fetchMock.mockResolvedValueOnce(ok({ data: { content: [{ activities: [{}] }] } }));
    const blank = await httpScrapeTracking("COSU1234567");
    expect(blank.shipment).toMatchObject({ attributes: {}, states: [{ date: "", status: "", location: "" }] });
  });

  it("Evergreen: blank events give empty fields and no attributes", async () => {
    fetchMock.mockResolvedValue(ok({ events: [{}] }));
    const r = await httpScrapeTracking("EVRU1234567");
    expect(r.shipment).toMatchObject({ attributes: {}, states: [{ date: "", status: "", location: "" }] });
  });
});

describe("carrier refusals and transport failures", () => {
  it.each([
    ["HLCU1234567", "Hapag HTTP 429"],
    ["COSU1234567", "COSCO HTTP 429"],
  ])("%s reports the HTTP status", async (container, error) => {
    fetchMock.mockResolvedValue(fail(429));
    expect(await httpScrapeTracking(container)).toEqual({ success: false, shipment: null, error });
  });

  it.each([
    ["HLCU1234567", "Hapag: socket hang up"],
    ["COSU1234567", "COSCO: socket hang up"],
    ["EVRU1234567", "Evergreen: socket hang up"],
    ["MSCU1234567", "MSC: socket hang up"],
  ])("%s turns a thrown fetch into an error result", async (container, error) => {
    fetchMock.mockRejectedValue(new Error("socket hang up"));
    expect(await httpScrapeTracking(container)).toEqual({ success: false, shipment: null, error });
  });

  it("reports a generic message for a non-Error rejection", async () => {
    fetchMock.mockRejectedValue("boom");
    expect((await httpScrapeTracking("HLCU1234567")).error).toBe("Hapag: Unexpected server error");
  });
});
