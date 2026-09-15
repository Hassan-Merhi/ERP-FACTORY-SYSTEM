import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const updates: Record<string, unknown>[] = [];
  const updateWhere = vi.fn(async () => []);
  const updateSet = vi.fn((values: Record<string, unknown>) => {
    updates.push(values);
    return { where: updateWhere };
  });

  return {
    updates,
    dbUpdate: vi.fn(() => ({ set: updateSet })),
    updateSet,
    updateWhere,
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),

    deriveLastStatus: vi.fn(),
    deriveLastLocation: vi.fn(),
    deriveLastEventDate: vi.fn(),
    trackContainer: vi.fn(),

    httpAvailable: vi.fn(),
    httpScrape: vi.fn(),
    scraperAvailable: vi.fn(),
    scrapeTracking: vi.fn(),
    maerskDirectAvailable: vi.fn(),
    scrapeMaerskDirect: vi.fn(),
    maerskPublicTrack: vi.fn(),
    seventeenConfigured: vi.fn(),
    seventeenTrack: vi.fn(),
    cmaPublicEnabled: vi.fn(),
    cmaPublicTrack: vi.fn(),
    cmaApiConfigured: vi.fn(),
    cmaApiTrack: vi.fn(),

    resolveShipmentEta: vi.fn(),
    resolveProviderEta: vi.fn(),
    saveDirectEvents: vi.fn(),
    saveParcelsEvents: vi.fn(),
    saveTrackingCheck: vi.fn(),
    quota: vi.fn(),
    progress: vi.fn(),
    progressInit: vi.fn(),
    cmaFallback: vi.fn(),
  };
});

vi.mock("../server/db", () => ({
  db: { update: harness.dbUpdate },
}));

vi.mock("../server/lib/logger", () => ({
  logger: {
    info: harness.loggerInfo,
    warn: harness.loggerWarn,
    error: harness.loggerError,
  },
}));

vi.mock("../server/lib/parcelsAppClient", () => ({
  deriveLastStatus: harness.deriveLastStatus,
  deriveLastLocation: harness.deriveLastLocation,
  deriveLastEventDate: harness.deriveLastEventDate,
  trackContainer: harness.trackContainer,
}));

vi.mock("../server/lib/httpTrackingScraper", () => ({
  isHttpScraperAvailable: harness.httpAvailable,
  httpScrapeTracking: harness.httpScrape,
}));

vi.mock("../server/lib/parcelsAppScraper", () => ({
  isScraperAvailable: harness.scraperAvailable,
  scrapeTracking: harness.scrapeTracking,
}));

vi.mock("../server/lib/maerskDirectScraper", () => ({
  isMaerskDirectScraperAvailable: harness.maerskDirectAvailable,
  scrapeMaerskDirect: harness.scrapeMaerskDirect,
}));

vi.mock("../server/lib/trackingProviders/maerskPublicProvider", () => ({
  track: harness.maerskPublicTrack,
}));

vi.mock("../server/lib/trackingProviders/seventeenTrackProvider", () => ({
  isConfigured: harness.seventeenConfigured,
  track: harness.seventeenTrack,
  CARRIER_CODES: { CMA: 100755 },
}));

vi.mock("../server/lib/trackingProviders/cmaPublicProvider", () => ({
  isEnabled: harness.cmaPublicEnabled,
  track: harness.cmaPublicTrack,
}));

vi.mock("../server/lib/trackingProviders/cmaCgmApiProvider", () => ({
  isConfigured: harness.cmaApiConfigured,
  track: harness.cmaApiTrack,
}));

vi.mock("../server/services/factory-container-tracking/persistence", () => ({
  resolveEtaFromProvider: harness.resolveProviderEta,
  resolveEtaFromShipment: harness.resolveShipmentEta,
  saveDirectEvents: harness.saveDirectEvents,
  saveParcelsAppEvents: harness.saveParcelsEvents,
  saveTrackingCheck: harness.saveTrackingCheck,
}));

vi.mock("../server/services/factory-container-tracking/progress-quota", () => ({
  check17trackQuota: harness.quota,
  ep: harness.progress,
  initProgress: harness.progressInit,
}));

vi.mock("../server/services/factory-container-tracking/track-one", () => ({
  trackViaParcelsAppFallback: harness.cmaFallback,
}));

import { trackViaParcelsApp } from "../server/services/factory-container-tracking/parcels-app";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const originalApiKey = process.env.PARCELSAPP_API_KEY;
const CMA_FALLBACK = {
  success: false,
  lastStatus: null,
  lastLocation: null,
  lastDescription: null,
  lastCheckedAt: NOW,
  error: "cma-fallback",
};

function directFailure(error = "no_data") {
  return {
    success: false,
    blocked: false,
    noData: true,
    error,
    eta: null,
    events: [],
    latestStatus: null,
    latestLocation: null,
    latestDescription: null,
    latestEventDate: null,
    raw: null,
  };
}

function directSuccess(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    blocked: false,
    noData: false,
    error: null,
    eta: "2026-10-20",
    events: [
      {
        date: new Date("2026-09-14T00:00:00.000Z"),
        status: "DEPARTED",
        location: "Durban",
        description: "Departed",
      },
    ],
    latestStatus: "IN_TRANSIT",
    latestLocation: "Durban",
    latestDescription: "Departed",
    latestEventDate: new Date("2026-09-14T00:00:00.000Z"),
    raw: { ok: true },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.updates.length = 0;
  delete process.env.PARCELSAPP_API_KEY;

  harness.deriveLastStatus.mockReturnValue("IN_TRANSIT");
  harness.deriveLastLocation.mockReturnValue("Durban");
  harness.deriveLastEventDate.mockReturnValue(new Date("2026-09-14T00:00:00.000Z"));

  harness.httpAvailable.mockReturnValue(false);
  harness.scraperAvailable.mockReturnValue(false);
  harness.maerskDirectAvailable.mockReturnValue(false);
  harness.seventeenConfigured.mockReturnValue(false);
  harness.cmaPublicEnabled.mockReturnValue(false);
  harness.cmaApiConfigured.mockReturnValue(false);

  harness.httpScrape.mockResolvedValue({ success: false, shipment: null, error: "http-no-data", rawResponse: null });
  harness.scrapeTracking.mockResolvedValue({ success: false, shipment: null, blocked: false, error: "scrape-no-data", rawResponse: null });
  harness.scrapeMaerskDirect.mockResolvedValue(directFailure("direct-no-data"));
  harness.maerskPublicTrack.mockResolvedValue(directFailure("public-no-data"));
  harness.seventeenTrack.mockResolvedValue(directFailure("17-no-data"));
  harness.cmaPublicTrack.mockResolvedValue(directFailure("cma-public-no-data"));
  harness.cmaApiTrack.mockResolvedValue(directFailure("cma-api-no-data"));
  harness.quota.mockResolvedValue(true);

  harness.resolveShipmentEta.mockReturnValue({ eta: null, source: null });
  harness.resolveProviderEta.mockReturnValue({ eta: null, source: null });
  harness.saveDirectEvents.mockResolvedValue(undefined);
  harness.saveParcelsEvents.mockResolvedValue(undefined);
  harness.saveTrackingCheck.mockResolvedValue(undefined);
  harness.cmaFallback.mockResolvedValue(CMA_FALLBACK);
  harness.trackContainer.mockResolvedValue({ success: false, shipment: null, timedOut: false, error: "api-failure", rawResponse: null });
});

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.PARCELSAPP_API_KEY;
  else process.env.PARCELSAPP_API_KEY = originalApiKey;
  vi.restoreAllMocks();
});

describe("Phase 30 Factory container tracking branch gaps", () => {
  it("fails closed when every free provider is unavailable and no ParcelsApp key exists", async () => {
    const result = await trackViaParcelsApp(101, "TCNU1234567", "OTHER", null, NOW, null);

    expect(result).toMatchObject({ success: false, error: "No tracking provider configured" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingLastCheckedAt: NOW, trackingError: "No tracking provider configured" });
  });

  it("returns immediately when the lightweight HTTP scraper succeeds", async () => {
    harness.httpAvailable.mockReturnValue(true);
    harness.httpScrape.mockResolvedValue({
      success: true,
      error: null,
      shipment: { states: [{ description: "Loaded" }] },
    });
    harness.resolveShipmentEta.mockReturnValue({ eta: "2026-10-01", source: "api" });

    const result = await trackViaParcelsApp(102, "TCNU1234567", "OTHER", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "IN_TRANSIT" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "http_scraper", arrivalDate: "2026-10-01" });
  });

  it("continues after an HTTP scraper miss", async () => {
    harness.httpAvailable.mockReturnValue(true);
    harness.httpScrape.mockResolvedValue({ success: false, shipment: null, error: "blocked" });

    const result = await trackViaParcelsApp(103, "TCNU1234567", "OTHER", null, NOW, null);

    expect(result.error).toBe("No tracking provider configured");
    expect(harness.httpScrape).toHaveBeenCalledTimes(1);
  });

  it("skips the HTTP scraper for detected CMA and uses the CMA fallback when carrier providers are unavailable", async () => {
    harness.httpAvailable.mockReturnValue(true);

    const result = await trackViaParcelsApp(104, "CMAU1234567", "CMA", "cma-chain", NOW, null, "Congo", "CMA");

    expect(result).toEqual(CMA_FALLBACK);
    expect(harness.httpScrape).not.toHaveBeenCalled();
    expect(harness.cmaFallback).toHaveBeenCalledWith(104, "CMAU1234567", "CMA", "cma-chain", NOW, null, "Congo", "CMA");
  });

  it("persists Maersk direct events and ETA on direct success", async () => {
    harness.maerskDirectAvailable.mockReturnValue(true);
    harness.scrapeMaerskDirect.mockResolvedValue(directSuccess());
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-20", source: "api" });

    const result = await trackViaParcelsApp(105, "MSKU1234567", "MAERSK", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "IN_TRANSIT" });
    expect(harness.saveParcelsEvents).toHaveBeenCalledTimes(1);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_scraper", arrivalDate: "2026-10-20" });
  });

  it("uses Maersk public tracking when the direct scraper is unavailable", async () => {
    harness.maerskPublicTrack.mockResolvedValue(directSuccess({ latestStatus: "ARRIVED" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-21", source: "events" });

    const result = await trackViaParcelsApp(106, "MRKU1234567", "MAERSK", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "ARRIVED" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_public", arrivalDate: "2026-10-21" });
  });

  it("handles Maersk public rate limiting and falls through without treating it as success", async () => {
    harness.maerskPublicTrack.mockResolvedValue(directFailure("rate_limited"));

    const result = await trackViaParcelsApp(107, "MRSU1234567", "MAERSK", null, NOW, null);

    expect(result.error).toBe("No tracking provider configured");
    expect(harness.saveTrackingCheck).toHaveBeenCalledWith(107, "maersk_public", "skipped", "rate_limited", null);
  });

  it("returns from the official CMA API on a CMA-prefix success", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directSuccess({ latestStatus: "BERTHED" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-22", source: "api" });

    const result = await trackViaParcelsApp(108, "CMDU1234567", "CMA", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "BERTHED" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "cma_cgm_api", arrivalDate: "2026-10-22" });
  });

  it("falls from CMA official no-data to the public CMA provider", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directFailure("official-no-data"));
    harness.cmaPublicEnabled.mockReturnValue(true);
    harness.cmaPublicTrack.mockResolvedValue(directSuccess({ latestStatus: "SAILED" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-23", source: "events" });

    const result = await trackViaParcelsApp(109, "APZU1234567", "CMA", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "SAILED" });
    expect(harness.cmaPublicTrack).toHaveBeenCalledTimes(1);
  });

  it("falls from a blocked CMA public provider to 17track", async () => {
    harness.cmaPublicEnabled.mockReturnValue(true);
    harness.cmaPublicTrack.mockResolvedValue(directFailure("datadome"));
    harness.seventeenConfigured.mockReturnValue(true);
    harness.quota.mockResolvedValue(true);
    harness.seventeenTrack.mockResolvedValue(directSuccess({ latestStatus: "GATE_IN" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-24", source: "events" });

    const result = await trackViaParcelsApp(110, "CGMU1234567", "CMA", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "GATE_IN" });
    expect(harness.seventeenTrack).toHaveBeenCalledWith("CGMU1234567", 100755);
  });

  it("uses the CMA-specific fallback when 17track quota is exhausted", async () => {
    harness.seventeenConfigured.mockReturnValue(true);
    harness.quota.mockResolvedValue(false);

    const result = await trackViaParcelsApp(111, "APMU1234567", "CMA", null, NOW, null);

    expect(result).toEqual(CMA_FALLBACK);
    expect(harness.seventeenTrack).not.toHaveBeenCalled();
  });

  it("uses the official CMA API opportunistically for a non-Maersk leasing container", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directSuccess({ latestStatus: "DISCHARGED" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-25", source: "api" });

    const result = await trackViaParcelsApp(112, "TIIU1234567", "OTHER", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "DISCHARGED" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "cma_cgm_api", arrivalDate: "2026-10-25" });
  });

  it("continues after an opportunistic CMA miss and can succeed through the generic scraper", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directFailure("not-on-cma"));
    harness.scraperAvailable.mockReturnValue(true);
    harness.scrapeTracking.mockResolvedValue({
      success: true,
      blocked: false,
      error: null,
      shipment: { states: [{ description: "Rail move" }] },
    });
    harness.resolveShipmentEta.mockReturnValue({ eta: "2026-10-26", source: "events" });

    const result = await trackViaParcelsApp(113, "TCNU1234567", "OTHER", null, NOW, null);

    expect(result.success).toBe(true);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "parcelsapp_scraper", arrivalDate: "2026-10-26" });
  });

  it("continues from a blocked generic scraper to successful generic 17track", async () => {
    harness.scraperAvailable.mockReturnValue(true);
    harness.scrapeTracking.mockResolvedValue({ success: false, shipment: null, blocked: true, error: "captcha" });
    harness.seventeenConfigured.mockReturnValue(true);
    harness.quota.mockResolvedValue(true);
    harness.seventeenTrack.mockResolvedValue(directSuccess({ latestStatus: "RAIL" }));
    harness.resolveProviderEta.mockReturnValue({ eta: "2026-10-27", source: "events" });

    const result = await trackViaParcelsApp(114, "OOLU1234567", "OTHER", null, NOW, null);

    expect(result).toMatchObject({ success: true, lastStatus: "RAIL" });
    expect(harness.seventeenTrack).toHaveBeenCalledWith("OOLU1234567");
  });

  it("skips generic 17track on exhausted quota and reaches the no-provider guard", async () => {
    harness.seventeenConfigured.mockReturnValue(true);
    harness.quota.mockResolvedValue(false);

    const result = await trackViaParcelsApp(115, "OOLU1234567", "OTHER", null, NOW, null);

    expect(result.error).toBe("No tracking provider configured");
    expect(harness.seventeenTrack).not.toHaveBeenCalled();
  });

  it("uses manual carrier hint for a successful ParcelsApp API call", async () => {
    process.env.PARCELSAPP_API_KEY = "phase30-key";
    harness.trackContainer.mockResolvedValue({
      success: true,
      timedOut: false,
      error: null,
      rawResponse: { ok: true },
      shipment: { states: [{ description: "Delivered" }] },
    });
    harness.resolveShipmentEta.mockReturnValue({ eta: "2026-10-28", source: "api" });

    const result = await trackViaParcelsApp(116, "OOLU1234567", "OTHER", "fallback", NOW, null, "Zambia", "MSC");

    expect(result.success).toBe(true);
    expect(harness.trackContainer).toHaveBeenCalledWith("OOLU1234567", "Zambia", "MSC");
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "parcelsapp", arrivalDate: "2026-10-28" });
  });

  it("retries a timed-out hinted ParcelsApp request without the hint and accepts the retry", async () => {
    process.env.PARCELSAPP_API_KEY = "phase30-key";
    harness.trackContainer
      .mockResolvedValueOnce({ success: false, shipment: null, timedOut: true, error: "timeout", rawResponse: null })
      .mockResolvedValueOnce({
        success: true,
        timedOut: false,
        error: null,
        rawResponse: { retry: true },
        shipment: { states: [{ description: "Recovered" }] },
      });
    harness.resolveShipmentEta.mockReturnValue({ eta: "2026-10-29", source: "events" });

    const result = await trackViaParcelsApp(117, "OOLU1234567", "MSC", null, NOW, null, "Congo");

    expect(result.success).toBe(true);
    expect(harness.trackContainer).toHaveBeenNthCalledWith(1, "OOLU1234567", "Congo", "MSC");
    expect(harness.trackContainer).toHaveBeenNthCalledWith(2, "OOLU1234567", "Congo", undefined);
  });

  it("returns a controlled timeout when an unhinted ParcelsApp request times out", async () => {
    process.env.PARCELSAPP_API_KEY = "phase30-key";
    harness.trackContainer.mockResolvedValue({ success: false, shipment: null, timedOut: true, error: "timeout", rawResponse: null });

    const result = await trackViaParcelsApp(118, "OOLU1234567", "OTHER", null, NOW, null, "Congo");

    expect(result).toMatchObject({ success: false, error: "Carrier timed out (dest=Congo)" });
    expect(harness.trackContainer).toHaveBeenCalledTimes(1);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "parcelsapp", trackingError: "Carrier timed out (dest=Congo)" });
  });

  it("returns the provider error for a non-timeout ParcelsApp failure", async () => {
    process.env.PARCELSAPP_API_KEY = "phase30-key";
    harness.trackContainer.mockResolvedValue({ success: false, shipment: null, timedOut: false, error: "bad-request", rawResponse: null });

    const result = await trackViaParcelsApp(119, "OOLU1234567", "OTHER", null, NOW, null, "Congo");

    expect(result).toMatchObject({ success: false, error: "bad-request" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingError: "bad-request", trackingProvider: "parcelsapp" });
  });
});
