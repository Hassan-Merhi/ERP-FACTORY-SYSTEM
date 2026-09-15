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

    genericResolveShipmentEta: vi.fn(),
    genericResolveProviderEta: vi.fn(),
    genericLogEtaResolution: vi.fn(),
    genericLogAndConfirmEta: vi.fn(),
    genericSaveDirectEvents: vi.fn(),
    genericSaveParcelsEvents: vi.fn(),
    genericSaveTrackingCheck: vi.fn(),
    genericQuota: vi.fn(),
    genericProgress: vi.fn(),
    genericProgressInit: vi.fn(),
    genericFinalApi: vi.fn(),
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

vi.mock("../server/services/container-tracking/eta", () => ({
  resolveEtaFromShipment: harness.genericResolveShipmentEta,
  resolveEtaFromProvider: harness.genericResolveProviderEta,
  logEtaResolution: harness.genericLogEtaResolution,
  logAndConfirmEta: harness.genericLogAndConfirmEta,
}));

vi.mock("../server/services/container-tracking/persistence", () => ({
  saveDirectEvents: harness.genericSaveDirectEvents,
  saveParcelsAppEvents: harness.genericSaveParcelsEvents,
  saveTrackingCheck: harness.genericSaveTrackingCheck,
}));

vi.mock("../server/services/container-tracking/quotas", () => ({
  check17trackQuota: harness.genericQuota,
}));

vi.mock("../server/services/container-tracking/validation-progress", () => ({
  CMA_PREFIXES: /^(CMAU|CMDU|APZU|CGMU|APMU|APHU|CXDU|CAAU|CAJU|CAIU)/i,
  ep: harness.genericProgress,
  initTrackingProgress: harness.genericProgressInit,
}));

vi.mock("../server/services/container-tracking/parcels-app-api", () => ({
  trackViaParcelsAppApi: harness.genericFinalApi,
}));

import { trackViaParcelsApp } from "../server/services/container-tracking/parcels-app";

const NOW = new Date("2026-09-15T10:00:00.000Z");
const GENERIC_FINAL = {
  success: false,
  lastStatus: null,
  lastLocation: null,
  lastDescription: null,
  lastCheckedAt: NOW,
  error: "parcelsapp-fallback",
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
  harness.genericQuota.mockResolvedValue(true);

  harness.genericResolveShipmentEta.mockReturnValue({ eta: null, source: null });
  harness.genericResolveProviderEta.mockReturnValue({ eta: null, source: null });
  harness.genericLogAndConfirmEta.mockResolvedValue(undefined);
  harness.genericSaveDirectEvents.mockResolvedValue(undefined);
  harness.genericSaveParcelsEvents.mockResolvedValue(undefined);
  harness.genericSaveTrackingCheck.mockResolvedValue(undefined);
  harness.genericFinalApi.mockResolvedValue(GENERIC_FINAL);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Phase 30 ERP container tracking branch gaps", () => {
  it("falls through to the canonical ParcelsApp API when optional providers are unavailable", async () => {
    await expect(trackViaParcelsApp(1, "TCNU1234567", "OTHER", "fallback", NOW, null, null, "Congo")).resolves.toEqual(
      GENERIC_FINAL
    );
    expect(harness.genericFinalApi).toHaveBeenCalledWith(1, "TCNU1234567", "OTHER", "fallback", NOW, null, "Congo");
  });

  it("returns immediately when the lightweight HTTP scraper supplies an ETA", async () => {
    harness.httpAvailable.mockReturnValue(true);
    harness.httpScrape.mockResolvedValue({
      success: true,
      error: null,
      rawResponse: { source: "http" },
      shipment: { states: [{ description: "Loaded" }] },
    });
    harness.genericResolveShipmentEta.mockReturnValue({ eta: "2026-10-01", source: "api" });

    const result = await trackViaParcelsApp(2, "TCNU1234567", "OTHER", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "IN_TRANSIT", lastLocation: "Durban" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "http_scraper", eta: "2026-10-01", etaSource: "api" });
    expect(harness.genericFinalApi).not.toHaveBeenCalled();
  });

  it("keeps HTTP status/events but continues when neither provider nor database has an ETA", async () => {
    harness.httpAvailable.mockReturnValue(true);
    harness.httpScrape.mockResolvedValue({
      success: true,
      error: null,
      rawResponse: null,
      shipment: { states: [{ description: "Gate out" }] },
    });

    await trackViaParcelsApp(3, "TCNU1234567", null, null, NOW, null, null);

    expect(harness.genericSaveParcelsEvents).toHaveBeenCalledTimes(1);
    expect(harness.genericFinalApi).toHaveBeenCalledTimes(1);
  });

  it("records an HTTP scraper miss and continues through the provider chain", async () => {
    harness.httpAvailable.mockReturnValue(true);
    harness.httpScrape.mockResolvedValue({ success: false, shipment: null, error: "blocked", rawResponse: "raw" });

    await trackViaParcelsApp(4, "TCNU1234567", null, null, NOW, null, null);

    expect(harness.genericSaveTrackingCheck).toHaveBeenCalledWith(4, "http_scraper", "error", "blocked", "raw");
    expect(harness.genericFinalApi).toHaveBeenCalledTimes(1);
  });

  it("uses the six-hour Maersk ETA cache without calling a provider", async () => {
    const lastChecked = new Date(NOW.getTime() - 60 * 60 * 1000);
    const result = await trackViaParcelsApp(5, "MSKU1234567", "MAERSK", null, NOW, "2026-10-02", lastChecked);

    expect(result).toMatchObject({ success: true, lastCheckedAt: lastChecked, error: null });
    expect(harness.maerskPublicTrack).not.toHaveBeenCalled();
    expect(harness.genericFinalApi).not.toHaveBeenCalled();
  });

  it("persists Maersk direct events and returns when the direct scraper resolves ETA", async () => {
    harness.maerskDirectAvailable.mockReturnValue(true);
    harness.scrapeMaerskDirect.mockResolvedValue(directSuccess());
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-20", source: "api" });

    const result = await trackViaParcelsApp(6, "MSKU1234567", "MAERSK", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "IN_TRANSIT" });
    expect(harness.genericSaveParcelsEvents).toHaveBeenCalledTimes(1);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_scraper", eta: "2026-10-20" });
  });

  it("handles a Maersk direct result with ETA but no events", async () => {
    harness.maerskDirectAvailable.mockReturnValue(true);
    harness.scrapeMaerskDirect.mockResolvedValue(directSuccess({ events: [], latestStatus: null, eta: "2026-10-21" }));

    const result = await trackViaParcelsApp(7, "MRKU1234567", "MAERSK", null, NOW, null, null);

    expect(result.success).toBe(true);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_scraper", eta: "2026-10-21", etaSource: "api" });
  });

  it("continues from Maersk direct status-only data to the public provider for ETA", async () => {
    harness.maerskDirectAvailable.mockReturnValue(true);
    harness.scrapeMaerskDirect.mockResolvedValue(directSuccess({ eta: null }));
    harness.genericResolveProviderEta
      .mockReturnValueOnce({ eta: null, source: null })
      .mockReturnValueOnce({ eta: "2026-10-22", source: "api" });
    harness.maerskPublicTrack.mockResolvedValue(directSuccess({ eta: "2026-10-22" }));

    const result = await trackViaParcelsApp(8, "MRSU1234567", "MAERSK", null, NOW, null, null);

    expect(result.success).toBe(true);
    expect(harness.maerskPublicTrack).toHaveBeenCalledTimes(1);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_public", eta: "2026-10-22" });
  });

  it("returns a controlled Maersk-unavailable result after direct and public failures", async () => {
    harness.maerskDirectAvailable.mockReturnValue(true);
    harness.scrapeMaerskDirect.mockResolvedValue(directFailure("direct-blocked"));
    harness.maerskPublicTrack.mockResolvedValue(directFailure("rate_limited"));

    const result = await trackViaParcelsApp(9, "MAEU1234567", "MAERSK", "fallback", NOW, null, null);

    expect(result).toMatchObject({ success: false, error: "maersk_providers_unavailable" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingLastCheckedAt: NOW });
    expect(harness.genericFinalApi).not.toHaveBeenCalled();
  });

  it("accepts a successful Maersk public result even when the direct scraper is unavailable", async () => {
    harness.maerskPublicTrack.mockResolvedValue(directSuccess());
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-23", source: "api" });

    const result = await trackViaParcelsApp(10, "HASU1234567", "MAERSK", null, NOW, null, null);

    expect(result.success).toBe(true);
    expect(harness.genericSaveDirectEvents).toHaveBeenCalledTimes(1);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "maersk_public", eta: "2026-10-23" });
  });

  it("uses the CMA API opportunistically for a leasing-prefix container", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directSuccess({ latestStatus: "DISCHARGED" }));
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-24", source: "api" });

    const result = await trackViaParcelsApp(11, "TCNU1234567", "OTHER", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "DISCHARGED" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "cma_cgm_api", eta: "2026-10-24" });
  });

  it("continues after the opportunistic CMA lookup reports no data", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directFailure("not-on-cma"));

    await trackViaParcelsApp(12, "TIIU1234567", "OTHER", null, NOW, null, null);

    expect(harness.cmaApiTrack).toHaveBeenCalledTimes(1);
    expect(harness.genericFinalApi).toHaveBeenCalledTimes(1);
  });

  it("returns from the official CMA chain on a CMA-prefix success", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directSuccess({ latestStatus: "ARRIVED" }));
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-25", source: "api" });

    const result = await trackViaParcelsApp(13, "CMAU1234567", "CMA", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "ARRIVED" });
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "cma_cgm_api" });
  });

  it("falls from the CMA official API to the CMA public endpoint", async () => {
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(directFailure("official-no-data"));
    harness.cmaPublicEnabled.mockReturnValue(true);
    harness.cmaPublicTrack.mockResolvedValue(directSuccess({ latestStatus: "BERTHED" }));
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-26", source: "events" });

    const result = await trackViaParcelsApp(14, "CMDU1234567", "CMA", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "BERTHED" });
    expect(harness.cmaPublicTrack).toHaveBeenCalledTimes(1);
  });

  it("falls from CMA public failure to 17track when quota is available", async () => {
    harness.cmaPublicEnabled.mockReturnValue(true);
    harness.cmaPublicTrack.mockResolvedValue(directFailure("datadome"));
    harness.seventeenConfigured.mockReturnValue(true);
    harness.genericQuota.mockResolvedValue(true);
    harness.seventeenTrack.mockResolvedValue(directSuccess({ latestStatus: "SAILED" }));
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-27", source: "events" });

    const result = await trackViaParcelsApp(15, "APZU1234567", "CMA", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "SAILED" });
    expect(harness.seventeenTrack).toHaveBeenCalledWith("APZU1234567", 100755);
  });

  it("uses the CMA ParcelsApp API fallback when 17track quota is exhausted", async () => {
    harness.seventeenConfigured.mockReturnValue(true);
    harness.genericQuota.mockResolvedValue(false);

    await trackViaParcelsApp(16, "CGMU1234567", "CMA", "cma-chain", NOW, null, null, "Zambia");

    expect(harness.seventeenTrack).not.toHaveBeenCalled();
    expect(harness.genericFinalApi).toHaveBeenCalledWith(16, "CGMU1234567", null, "cma-chain", NOW, null, "Zambia");
  });

  it("returns from the generic Puppeteer scraper on success", async () => {
    harness.scraperAvailable.mockReturnValue(true);
    harness.scrapeTracking.mockResolvedValue({
      success: true,
      blocked: false,
      error: null,
      rawResponse: null,
      shipment: { states: [{ description: "Rail move" }] },
    });
    harness.genericResolveShipmentEta.mockReturnValue({ eta: "2026-10-28", source: "events" });

    const result = await trackViaParcelsApp(17, "OOLU1234567", "OTHER", null, NOW, null, null);

    expect(result.success).toBe(true);
    expect(harness.updates.at(-1)).toMatchObject({ trackingProvider: "parcelsapp_scraper", eta: "2026-10-28" });
  });

  it("continues from a blocked generic scraper to a successful 17track result", async () => {
    harness.scraperAvailable.mockReturnValue(true);
    harness.scrapeTracking.mockResolvedValue({ success: false, shipment: null, blocked: true, error: "captcha", rawResponse: null });
    harness.seventeenConfigured.mockReturnValue(true);
    harness.seventeenTrack.mockResolvedValue(directSuccess({ latestStatus: "GATE_IN" }));
    harness.genericResolveProviderEta.mockReturnValue({ eta: "2026-10-29", source: "events" });

    const result = await trackViaParcelsApp(18, "OOLU1234567", "OTHER", null, NOW, null, null);

    expect(result).toMatchObject({ success: true, lastStatus: "GATE_IN" });
    expect(harness.seventeenTrack).toHaveBeenCalledWith("OOLU1234567");
  });

  it("skips generic 17track when quota is exhausted and reaches the final API", async () => {
    harness.seventeenConfigured.mockReturnValue(true);
    harness.genericQuota.mockResolvedValue(false);

    await trackViaParcelsApp(19, "OOLU1234567", "OTHER", null, NOW, null, null);

    expect(harness.seventeenTrack).not.toHaveBeenCalled();
    expect(harness.genericFinalApi).toHaveBeenCalledTimes(1);
  });

  it("continues to the final API after a generic 17track failure", async () => {
    harness.seventeenConfigured.mockReturnValue(true);
    harness.genericQuota.mockResolvedValue(true);
    harness.seventeenTrack.mockResolvedValue(directFailure("provider-error"));

    await trackViaParcelsApp(20, "OOLU1234567", "OTHER", null, NOW, null, null);

    expect(harness.genericSaveTrackingCheck).toHaveBeenCalledWith(20, "17track", "no_data", "provider-error", null);
    expect(harness.genericFinalApi).toHaveBeenCalledTimes(1);
  });
});
