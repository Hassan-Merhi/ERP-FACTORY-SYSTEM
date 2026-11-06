import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deriveEstimatedDeliveryDate,
  deriveLastEventDate,
  normaliseEvents,
  trackContainer,
  type ParcelsAppShipment,
} from "../server/lib/parcelsAppClient";
import { logger } from "../server/lib/logger";

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const shipment = (over: Partial<ParcelsAppShipment> = {}): ParcelsAppShipment => ({
  trackingId: "MSKU1234567",
  done: true,
  ...over,
});
const states = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ date: `2026-10-${String(10 + i).padStart(2, "0")}`, status: `S${i}` }));

const originalKey = process.env.PARCELSAPP_API_KEY;

beforeEach(() => {
  process.env.PARCELSAPP_API_KEY = "secret-key";
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (originalKey === undefined) delete process.env.PARCELSAPP_API_KEY;
  else process.env.PARCELSAPP_API_KEY = originalKey;
});

/** Runs a tracking call while letting every scheduled sleep elapse. */
async function track(...args: Parameters<typeof trackContainer>) {
  const pending = trackContainer(...args);
  await vi.runAllTimersAsync();
  return pending;
}

describe("trackContainer", () => {
  it("needs an API key", async () => {
    delete process.env.PARCELSAPP_API_KEY;
    await expect(trackContainer("MSKU1")).resolves.toEqual({
      success: false,
      shipment: null,
      rawResponse: null,
      error: "PARCELSAPP_API_KEY is not configured",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the shipment and uses a cached result immediately", async () => {
    const other = shipment({ trackingId: "OTHER" });
    const mine = shipment({ states: states(2) });
    fetchMock.mockResolvedValueOnce(json({ done: true, fromCache: true, shipments: [other, mine] }));
    const result = await track("MSKU1234567", "Zambia", "MAERSK");
    expect(result).toEqual({
      success: true,
      shipment: mine,
      rawResponse: { uuid: "", done: true, shipments: [other, mine], fromCache: true },
      timedOut: false,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://parcelsapp.com/api/v3/shipments/tracking");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      shipments: [{ trackingId: "MSKU1234567", destinationCountry: "Zambia", carrier: "MAERSK" }],
      language: "en",
      apiKey: "secret-key",
    });
  });

  it("treats shipments without a uuid as done and defaults the destination", async () => {
    const only = shipment({ trackingId: "DIFFERENT" });
    fetchMock.mockResolvedValueOnce(json({ shipments: [only] }));
    const result = await track("MSKU1234567", undefined as unknown as string);
    expect(result).toMatchObject({ success: true, shipment: only });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).shipments[0]).toEqual({
      trackingId: "MSKU1234567",
      destinationCountry: "United States",
    });

    fetchMock.mockResolvedValueOnce(json({ done: true, shipments: [] }));
    await expect(track("MSKU1234567")).resolves.toMatchObject({ success: true, shipment: null });
  });

  it("polls until done and keeps the richest shipment seen", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ uuid: "abc 1", done: false }))
      .mockResolvedValueOnce(json({ done: false, shipments: [shipment({ states: states(3) })] }))
      .mockResolvedValueOnce(json({ done: false }))
      .mockResolvedValueOnce(new Response("gateway", { status: 502 }))
      .mockResolvedValueOnce(json({ done: true, shipments: [shipment({ states: states(1) })] }));
    const result = await track("MSKU1234567");
    expect(result.success).toBe(true);
    expect(result.timedOut).toBe(false);
    expect(result.shipment?.states).toHaveLength(3);
    expect(result.rawResponse).toEqual({ done: true, shipments: [shipment({ states: states(1) })] });
    expect(fetchMock.mock.calls[1][0]).toBe(
      "https://parcelsapp.com/api/v3/shipments/tracking?uuid=abc%201&apiKey=secret-key"
    );
    expect(fetchMock.mock.calls[1][1].method).toBe("GET");
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsApp] Poll attempt 3 error: ParcelsApp GET failed: 502 gateway");
  });

  it("returns partial data or a timeout after 18 polls", async () => {
    fetchMock.mockResolvedValueOnce(json({ uuid: "u", done: false }));
    fetchMock.mockImplementation(async () => json({ done: false, shipments: [shipment({ states: states(2) })] }));
    let result = await track("MSKU1234567");
    expect(fetchMock).toHaveBeenCalledTimes(19);
    expect(result).toMatchObject({ success: true, timedOut: true });
    expect(result.shipment?.states).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith(
      "[ParcelsApp] MSKU1234567: timed out but returning partial data (2 events)"
    );
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining("Poll attempt"));

    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json({ uuid: "u", done: false }));
    fetchMock.mockImplementation(async () => json({ done: false, shipments: [] }));
    result = await track("MSKU1234567");
    expect(result).toEqual({
      success: false,
      shipment: null,
      rawResponse: { done: false, shipments: [] },
      error: "Tracking request timed out after polling",
      timedOut: true,
    });
  });

  it("retries a busy server three times, then gives up", async () => {
    fetchMock
      .mockResolvedValueOnce(json({ error: "BUSY" }))
      .mockResolvedValueOnce(json({ error: "BUSY" }))
      .mockResolvedValueOnce(json({ done: true, shipments: [shipment()] }));
    await expect(track("MSKU1234567")).resolves.toMatchObject({ success: true });
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsApp] MSKU1234567: BUSY — retry 2/3 in 6s");

    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => json({ error: "BUSY" }));
    await expect(track("MSKU1234567")).resolves.toEqual({
      success: false,
      shipment: null,
      rawResponse: null,
      error: "ParcelsApp POST: server busy (BUSY)",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports a failed or empty initiation", async () => {
    fetchMock.mockResolvedValueOnce(new Response("x".repeat(300), { status: 429 }));
    let result = await track("MSKU1234567");
    expect(result.success).toBe(false);
    expect(result.error).toBe(`ParcelsApp POST failed: 429 ${"x".repeat(200)}`);

    fetchMock.mockResolvedValueOnce(json({ done: false }));
    result = await track("MSKU1234567");
    expect(result.error).toBe('ParcelsApp POST: no uuid in response (raw={"done":false})');

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    result = await track("MSKU1234567");
    expect(result.error).toBe("network down");
  });

  it("stops polling if the API key disappears", async () => {
    fetchMock.mockResolvedValueOnce(json({ uuid: "u", done: false }));
    const pending = trackContainer("MSKU1234567");
    delete process.env.PARCELSAPP_API_KEY;
    await vi.runAllTimersAsync();
    const result = await pending;
    expect(result).toMatchObject({ success: false, timedOut: true });
    expect(logger.warn).toHaveBeenCalledWith("[ParcelsApp] Poll attempt 1 error: PARCELSAPP_API_KEY is not configured");
  });
});

describe("shipment helpers", () => {
  it("normalises events and the latest event date", () => {
    expect(normaliseEvents(shipment())).toEqual([]);
    expect(
      normaliseEvents(
        shipment({
          states: [
            { date: "2026-10-01", status: "Gate out", location: "Durban", description: "Empty" },
            { date: "2026-09-30", status: "Loaded" },
          ],
        })
      )
    ).toEqual([
      { date: "2026-10-01", status: "Gate out", location: "Durban", description: "Empty" },
      { date: "2026-09-30", status: "Loaded", location: null, description: null },
    ]);
    expect(deriveLastEventDate(shipment())).toBeNull();
    expect(deriveLastEventDate(shipment({ states: [{ date: "garbage", status: "x" }] }))).toBeNull();
    expect(deriveLastEventDate(shipment({ states: [{ date: "2026-10-01T05:00:00Z", status: "x" }] }))).toEqual(
      new Date("2026-10-01T05:00:00Z")
    );
  });

  it("finds an ETA from top-level fields, attributes or key patterns", () => {
    expect(deriveEstimatedDeliveryDate(shipment({ eta: "bad", estimatedDelivery: "2026-11-02" }))).toBe("2026-11-02");
    expect(deriveEstimatedDeliveryDate({ ...shipment(), ETA: "2026-11-03T10:00:00Z" } as ParcelsAppShipment)).toBe(
      "2026-11-03"
    );
    expect(
      deriveEstimatedDeliveryDate(
        shipment({ attributes: [{ l: "plannedArrivalDate", val: "2026-11-04" }, { l: "eta", val: 5 }, null as never] })
      )
    ).toBe("2026-11-04");
    expect(deriveEstimatedDeliveryDate(shipment({ attributes: { etaPortOfDischarge: "2026-11-05" } }))).toBe(
      "2026-11-05"
    );
    expect(
      deriveEstimatedDeliveryDate(shipment({ attributes: { actualArrival: "2026-09-01", eta_text: "" } }))
    ).toBeNull();
  });

  it("uses delivered_by only when it is in the future", () => {
    expect(deriveEstimatedDeliveryDate(shipment({ delivered_by: "2026-10-25" }))).toBe("2026-10-25");
    expect(deriveEstimatedDeliveryDate(shipment({ delivered_by: "2026-10-20" }))).toBeNull();
    expect(deriveEstimatedDeliveryDate(shipment({ delivered_by: "never" }))).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(
      "[ParcelsApp] deriveEDD: using delivered_by=2026-10-25 as future ETA (2026-10-25)"
    );
  });

  it("reads an ETA event dated today or later, else the latest arrival event", () => {
    for (const status of ["Estimated Time of Arrival, Vessel: X", "estimated arrival", "ETA", "eta Durban"]) {
      expect(deriveEstimatedDeliveryDate(shipment({ states: [{ date: "2026-10-20", status }] }))).toBe("2026-10-20");
    }
    // A past ETA event is not an ETA; with no arrival either, nothing is known.
    expect(deriveEstimatedDeliveryDate(shipment({ states: [{ date: "2026-10-01", status: "ETA" }] }))).toBeNull();
    expect(
      deriveEstimatedDeliveryDate(
        shipment({
          states: [
            { date: "2026-10-12", status: "Gate out" },
            { date: "", status: "Discharged" },
            { date: "nope", status: "Discharged" },
            { date: "2026-10-08", status: "Vessel", description: "Import discharge at Durban" },
            { date: "2026-10-01", status: "Arrived" },
          ],
        })
      )
    ).toBe("2026-10-08");
    expect(deriveEstimatedDeliveryDate(shipment({ states: [{ date: "2026-10-12", status: "Gate out" }] }))).toBeNull();
  });
});
