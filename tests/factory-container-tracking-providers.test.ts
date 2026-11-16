import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dbUpdate: vi.fn(),
  dbSet: vi.fn(),
  dbWhere: vi.fn(),
  loggerInfo: vi.fn(),
  deriveLastStatus: vi.fn(),
  deriveLastLocation: vi.fn(),
  deriveLastEventDate: vi.fn(),
  httpAvailable: vi.fn(),
  httpTrack: vi.fn(),
  scraperAvailable: vi.fn(),
  scrapeTracking: vi.fn(),
  maerskDirectAvailable: vi.fn(),
  maerskDirectTrack: vi.fn(),
  maerskPublicTrack: vi.fn(),
  seventeenConfigured: vi.fn(),
  seventeenTrack: vi.fn(),
  cmaPublicEnabled: vi.fn(),
  cmaPublicTrack: vi.fn(),
  cmaApiConfigured: vi.fn(),
  cmaApiTrack: vi.fn(),
  resolveEtaFromProvider: vi.fn(),
  resolveEtaFromShipment: vi.fn(),
  saveDirectEvents: vi.fn(),
  saveParcelsAppEvents: vi.fn(),
  saveTrackingCheck: vi.fn(),
  check17trackQuota: vi.fn(),
  ep: vi.fn(),
  initProgress: vi.fn(),
  fallback: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: { update: harness.dbUpdate },
}));
vi.mock("../server/lib/logger", () => ({ logger: { info: harness.loggerInfo } }));
vi.mock("../server/lib/parcelsAppClient", () => ({
  trackContainer: vi.fn(),
  deriveLastStatus: harness.deriveLastStatus,
  deriveLastLocation: harness.deriveLastLocation,
  deriveLastEventDate: harness.deriveLastEventDate,
}));
vi.mock("../server/lib/parcelsAppScraper", () => ({
  scrapeTracking: harness.scrapeTracking,
  isScraperAvailable: harness.scraperAvailable,
}));
vi.mock("../server/lib/httpTrackingScraper", () => ({
  httpScrapeTracking: harness.httpTrack,
  isHttpScraperAvailable: harness.httpAvailable,
}));
vi.mock("../server/lib/maerskDirectScraper", () => ({
  scrapeMaerskDirect: harness.maerskDirectTrack,
  isMaerskDirectScraperAvailable: harness.maerskDirectAvailable,
}));
vi.mock("../server/lib/trackingProviders/maerskPublicProvider", () => ({ track: harness.maerskPublicTrack }));
vi.mock("../server/lib/trackingProviders/seventeenTrackProvider", () => ({
  isConfigured: harness.seventeenConfigured,
  track: harness.seventeenTrack,
  CARRIER_CODES: { CMA: 172 },
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
  resolveEtaFromProvider: harness.resolveEtaFromProvider,
  resolveEtaFromShipment: harness.resolveEtaFromShipment,
  saveDirectEvents: harness.saveDirectEvents,
  saveParcelsAppEvents: harness.saveParcelsAppEvents,
  saveTrackingCheck: harness.saveTrackingCheck,
}));
vi.mock("../server/services/factory-container-tracking/progress-quota", () => ({
  check17trackQuota: harness.check17trackQuota,
  ep: harness.ep,
  initProgress: harness.initProgress,
}));
vi.mock("../server/services/factory-container-tracking/track-one", () => ({
  trackViaParcelsAppFallback: harness.fallback,
}));

import { trackViaParcelsApp } from "../server/services/factory-container-tracking/parcels-app";

beforeEach(() => {
  vi.clearAllMocks();

  harness.dbWhere.mockResolvedValue(undefined);
  harness.dbSet.mockReturnValue({ where: harness.dbWhere });
  harness.dbUpdate.mockReturnValue({ set: harness.dbSet });

  harness.httpAvailable.mockReturnValue(false);
  harness.scraperAvailable.mockReturnValue(false);
  harness.maerskDirectAvailable.mockReturnValue(false);
  harness.seventeenConfigured.mockReturnValue(false);
  harness.cmaPublicEnabled.mockReturnValue(false);
  harness.cmaApiConfigured.mockReturnValue(false);
  harness.check17trackQuota.mockResolvedValue(false);
  harness.resolveEtaFromProvider.mockReturnValue({ eta: null, etaSource: "none" });
  harness.resolveEtaFromShipment.mockReturnValue({ eta: null, etaSource: "none" });
});

describe("phase 32 factory container tracking high-line provider paths", () => {
  it("persists and returns a successful generic HTTP scraper result", async () => {
    const now = new Date("2026-09-15T10:00:00.000Z");
    const shipment = {
      trackingId: "TCLU1234567",
      done: false,
      attributes: { estimatedArrival: "2026-10-01" },
      states: [{ date: "2026-09-14", status: "IN_TRANSIT", location: "Durban", description: "Loaded" }],
    };
    harness.httpAvailable.mockReturnValue(true);
    harness.httpTrack.mockResolvedValue({ success: true, shipment });
    harness.deriveLastStatus.mockReturnValue("IN_TRANSIT");
    harness.deriveLastLocation.mockReturnValue("Durban");
    harness.deriveLastEventDate.mockReturnValue(new Date("2026-09-14T00:00:00.000Z"));
    harness.resolveEtaFromShipment.mockReturnValue({ eta: "2026-10-01", etaSource: "provider" });

    const result = await trackViaParcelsApp(41, "TCLU1234567", "OTHER", null, now, null, "Congo", null);

    expect(result).toEqual({
      success: true,
      lastStatus: "IN_TRANSIT",
      lastLocation: "Durban",
      lastDescription: "Loaded",
      lastCheckedAt: now,
      error: null,
    });
    expect(harness.saveParcelsAppEvents).toHaveBeenCalledWith(41, shipment);
    expect(harness.dbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingProvider: "http_scraper",
        trackingDetectedCarrier: "OTHER",
        trackingLastStatus: "IN_TRANSIT",
        arrivalDate: "2026-10-01",
        trackingError: null,
      })
    );
    expect(harness.ep).toHaveBeenCalledWith(41, "HTTP scraper", "success", "IN_TRANSIT");
    expect(harness.maerskPublicTrack).not.toHaveBeenCalled();
  });

  it("falls through unavailable HTTP/Puppeteer tracking to the Maersk public provider", async () => {
    const now = new Date("2026-09-15T11:00:00.000Z");
    const event = {
      date: new Date("2026-09-13T00:00:00.000Z"),
      status: "LOADED",
      location: "Cape Town",
      description: "Vessel departed",
    };
    const providerResult = {
      success: true,
      blocked: false,
      error: null,
      raw: { provider: "maersk" },
      latestStatus: "LOADED",
      latestLocation: "Cape Town",
      latestEventDate: event.date,
      latestDescription: event.description,
      eta: "2026-10-02",
      events: [event],
    };
    harness.maerskPublicTrack.mockResolvedValue(providerResult);
    harness.resolveEtaFromProvider.mockReturnValue({ eta: "2026-10-02", etaSource: "provider" });

    const result = await trackViaParcelsApp(42, "MRKU1234567", "MAERSK", null, now, null);

    expect(result).toMatchObject({
      success: true,
      lastStatus: "LOADED",
      lastLocation: "Cape Town",
      lastDescription: "Vessel departed",
      lastCheckedAt: now,
      error: null,
    });
    expect(harness.ep).toHaveBeenCalledWith(42, "Maersk Puppeteer", "skip", "not available");
    expect(harness.maerskPublicTrack).toHaveBeenCalledWith("MRKU1234567");
    expect(harness.saveTrackingCheck).toHaveBeenCalledWith(42, "maersk_public", "success", null, providerResult.raw);
    expect(harness.saveDirectEvents).toHaveBeenCalledWith(42, providerResult);
    expect(harness.dbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingProvider: "maersk_public",
        arrivalDate: "2026-10-02",
        trackingLastStatus: "LOADED",
      })
    );
  });

  it("skips generic HTTP for CMA and uses the configured official CMA API first", async () => {
    const now = new Date("2026-09-15T12:00:00.000Z");
    const providerResult = {
      success: true,
      noData: false,
      error: null,
      raw: { provider: "cma_api" },
      latestStatus: "DISCHARGED",
      latestLocation: "Matadi",
      latestEventDate: new Date("2026-09-15T06:00:00.000Z"),
      latestDescription: "Discharged at destination",
      eta: "2026-09-15",
      events: [
        {
          date: new Date("2026-09-15T06:00:00.000Z"),
          status: "DISCHARGED",
          location: "Matadi",
          description: "Discharged at destination",
        },
      ],
    };
    harness.httpAvailable.mockReturnValue(true);
    harness.cmaApiConfigured.mockReturnValue(true);
    harness.cmaApiTrack.mockResolvedValue(providerResult);
    harness.resolveEtaFromProvider.mockReturnValue({ eta: "2026-09-15", etaSource: "provider" });

    const result = await trackViaParcelsApp(43, "CMAU7654321", "CMA", null, now, null);

    expect(harness.httpTrack).not.toHaveBeenCalled();
    expect(harness.ep).toHaveBeenCalledWith(43, "HTTP scraper", "skip", "CMA uses dedicated provider chain");
    expect(harness.cmaApiTrack).toHaveBeenCalledWith("CMAU7654321");
    expect(harness.saveTrackingCheck).toHaveBeenCalledWith(43, "cma_cgm_api", "success", null, providerResult.raw);
    expect(harness.saveDirectEvents).toHaveBeenCalledWith(43, providerResult);
    expect(harness.dbSet).toHaveBeenCalledWith(
      expect.objectContaining({
        trackingProvider: "cma_cgm_api",
        trackingDetectedCarrier: "CMA",
        trackingLastStatus: "DISCHARGED",
        arrivalDate: "2026-09-15",
      })
    );
    expect(result).toMatchObject({
      success: true,
      lastStatus: "DISCHARGED",
      lastLocation: "Matadi",
      lastDescription: "Discharged at destination",
      error: null,
    });
    expect(harness.cmaPublicTrack).not.toHaveBeenCalled();
    expect(harness.seventeenTrack).not.toHaveBeenCalled();
  });
});
