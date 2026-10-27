/**
 * The ERP container tracker's provider chain when providers answer only in
 * part: no status, no ETA, no error text, blocked or no-data results. Every
 * provider, the database writes and the ParcelsApp API step are stubbed; the
 * progress steps and ETA resolution are the real ones.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CarrierTrackResult } from "../server/lib/trackingProviders/types";

const h = vi.hoisted(() => ({
  updates: [] as Array<Record<string, unknown>>,
  http: vi.fn(),
  httpAvailable: false,
  scraper: vi.fn(),
  scraperAvailable: false,
  maerskDirect: vi.fn(),
  maerskDirectAvailable: false,
  maerskPublic: vi.fn(),
  seventeen: vi.fn(),
  seventeenConfigured: false,
  cmaPublic: vi.fn(),
  cmaPublicEnabled: false,
  cmaApi: vi.fn(),
  cmaApiConfigured: false,
  quota: vi.fn(),
  api: vi.fn(),
  check: vi.fn(),
  events: vi.fn(),
  parcelsEvents: vi.fn(),
  confirm: vi.fn(),
}));

vi.mock("../server/db", () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          h.updates.push(values);
        },
      }),
    }),
  },
}));
vi.mock("../server/lib/httpTrackingScraper", () => ({
  httpScrapeTracking: (...a: unknown[]) => h.http(...a),
  isHttpScraperAvailable: () => h.httpAvailable,
}));
vi.mock("../server/lib/parcelsAppScraper", () => ({
  scrapeTracking: (...a: unknown[]) => h.scraper(...a),
  isScraperAvailable: () => h.scraperAvailable,
}));
vi.mock("../server/lib/maerskDirectScraper", () => ({
  scrapeMaerskDirect: (...a: unknown[]) => h.maerskDirect(...a),
  isMaerskDirectScraperAvailable: () => h.maerskDirectAvailable,
}));
vi.mock("../server/lib/trackingProviders/maerskPublicProvider", () => ({
  track: (...a: unknown[]) => h.maerskPublic(...a),
}));
vi.mock("../server/lib/trackingProviders/seventeenTrackProvider", () => ({
  track: (...a: unknown[]) => h.seventeen(...a),
  isConfigured: () => h.seventeenConfigured,
  CARRIER_CODES: { CMA: 100755 },
}));
vi.mock("../server/lib/trackingProviders/cmaPublicProvider", () => ({
  track: (...a: unknown[]) => h.cmaPublic(...a),
  isEnabled: () => h.cmaPublicEnabled,
}));
vi.mock("../server/lib/trackingProviders/cmaCgmApiProvider", () => ({
  track: (...a: unknown[]) => h.cmaApi(...a),
  isConfigured: () => h.cmaApiConfigured,
}));
vi.mock("../server/services/container-tracking/quotas", () => ({ check17trackQuota: () => h.quota() }));
vi.mock("../server/services/container-tracking/parcels-app-api", () => ({
  trackViaParcelsAppApi: (...a: unknown[]) => h.api(...a),
}));
vi.mock("../server/services/container-tracking/persistence", () => ({
  saveTrackingCheck: (...a: unknown[]) => h.check(...a),
  saveDirectEvents: (...a: unknown[]) => h.events(...a),
  saveParcelsAppEvents: (...a: unknown[]) => h.parcelsEvents(...a),
}));
vi.mock("../server/services/container-tracking/eta", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/container-tracking/eta")>()),
  logAndConfirmEta: (...a: unknown[]) => h.confirm(...a),
  logEtaResolution: () => undefined,
}));

import { logger } from "../server/lib/logger";
import { trackViaParcelsApp } from "../server/services/container-tracking/parcels-app";
import { getTrackingProgress } from "../server/services/container-tracking/validation-progress";

const NOW = new Date("2026-10-20T12:00:00Z");
const API_RESULT = { success: false, fromApi: true };
let id = 0;

const carrier = (over: Partial<CarrierTrackResult> = {}): CarrierTrackResult => ({
  success: true,
  provider: "p",
  carrier: null,
  containerNumber: "X",
  latestStatus: null,
  latestLocation: null,
  latestEventDate: null,
  latestDescription: null,
  eta: null,
  events: [],
  raw: null,
  ...over,
});
const anEvent = { date: new Date("2026-10-18T00:00:00Z"), status: "LOAD", location: "Durban", description: null };
const steps = (containerId: number) => getTrackingProgress(containerId).map((s) => [s.label, s.status, s.detail]);
const checkStatuses = () => h.check.mock.calls.map((call) => [call[1], call[2], call[3]]);
const run = (number: string, currentEta: string | null = null, lastCheckedAt: Date | null = null) => {
  const containerId = 7000 + ++id;
  return {
    containerId,
    result: trackViaParcelsApp(containerId, number, "OTHER", null, NOW, currentEta, lastCheckedAt),
  };
};

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.restoreAllMocks();
  for (const fn of [
    h.http,
    h.scraper,
    h.maerskDirect,
    h.maerskPublic,
    h.seventeen,
    h.cmaPublic,
    h.cmaApi,
    h.quota,
    h.api,
    h.check,
    h.events,
    h.parcelsEvents,
    h.confirm,
  ])
    fn.mockReset();
  h.updates = [];
  h.httpAvailable = h.scraperAvailable = h.maerskDirectAvailable = false;
  h.seventeenConfigured = h.cmaPublicEnabled = h.cmaApiConfigured = false;
  h.api.mockResolvedValue(API_RESULT);
  h.quota.mockResolvedValue(true);
  info = vi.spyOn(logger, "info").mockImplementation(() => logger);
  warn = vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

describe("HTTP scraper step", () => {
  it("keeps going for an ETA when the scrape has events but no status or ETA", async () => {
    h.httpAvailable = true;
    h.http.mockResolvedValue({ success: true, shipment: { trackingId: "T", done: true, states: [{ date: "x" }] } });
    const { containerId, result } = run("TCNU1234567");
    await expect(result).resolves.toBe(API_RESULT);
    expect(steps(containerId)).toEqual([["HTTP scraper", "success", "got data"]]);
    expect(checkStatuses()).toEqual([["http_scraper", "success", null]]);
    expect(info).toHaveBeenCalledWith("[ContainerTracking] TCNU1234567 → http_scraper: status=?");
    expect(h.updates[0]).not.toHaveProperty("eta");
    expect(h.confirm.mock.calls[0][6]).toBe("no explicit ETA field found — existing ETA preserved");
  });

  it("records a scrape with no data or error text", async () => {
    h.httpAvailable = true;
    h.http.mockResolvedValue({ success: false });
    const { containerId, result } = run("TCNU1234567");
    await result;
    expect(steps(containerId)).toEqual([["HTTP scraper", "skip", "no data"]]);
    expect(checkStatuses()).toEqual([["http_scraper", "error", null]]);
  });
});

describe("Maersk providers", () => {
  it("skips both Maersk providers while a cached ETA is under six hours old", async () => {
    h.maerskDirectAvailable = true;
    const { result } = run("MSKU1234567", "2026-11-01", new Date(NOW.getTime() - 5 * 60 * 60 * 1000));
    await expect(result).resolves.toMatchObject({ success: true, lastStatus: null });
    expect(h.maerskDirect).not.toHaveBeenCalled();
    h.maerskPublic.mockResolvedValue(carrier({ success: false, error: "rate_limited" }));
    h.maerskDirect.mockResolvedValue({ success: false, blocked: true });
    const stale = run("MSKU1234567", "2026-11-01", new Date(NOW.getTime() - 6 * 60 * 60 * 1000));
    await stale.result;
    expect(h.maerskDirect).toHaveBeenCalled();
  });

  it("records a blocked Puppeteer run and a Maersk public failure without error text, then stops the chain", async () => {
    h.maerskDirectAvailable = true;
    h.maerskDirect.mockResolvedValue({ success: false, blocked: true });
    h.maerskPublic.mockResolvedValue(carrier({ success: false, blocked: true }));
    const { containerId, result } = run("MSKU1234567", "2026-11-01");
    await expect(result).resolves.toMatchObject({ success: false, error: "maersk_providers_unavailable" });
    expect(steps(containerId)).toEqual([
      ["Maersk Puppeteer", "fail", "no data"],
      ["Maersk public HTTP", "fail", "no data"],
    ]);
    expect(checkStatuses()).toEqual([
      ["maersk_scraper", "blocked", null],
      ["maersk_public", "blocked", null],
    ]);
    expect(info).toHaveBeenCalledWith(
      "[ContainerTracking] MSKU1234567: Maersk chain exhausted — preserving ETA=2026-11-01"
    );
    expect(h.api).not.toHaveBeenCalled();
  });

  it("saves Puppeteer events with blank fields and continues for an ETA", async () => {
    h.maerskDirectAvailable = true;
    h.maerskDirect.mockResolvedValue(
      carrier({
        latestStatus: null,
        latestLocation: "Durban",
        eta: null,
        events: [{ date: null, status: null, location: null, description: null }],
        raw: undefined,
      })
    );
    // A success with no status and no ETA is not usable at all.
    h.maerskPublic.mockResolvedValue(carrier({ success: false, error: "http_500" }));
    const empty = run("MSKU1234567");
    await empty.result;
    expect(steps(empty.containerId)[0]).toEqual(["Maersk Puppeteer", "fail", "no data"]);

    h.maerskDirect.mockResolvedValue(
      carrier({
        latestStatus: "LOAD",
        events: [{ date: null, status: null, location: null, description: null }],
      })
    );
    h.maerskPublic.mockResolvedValue(carrier({ success: false, error: "rate_limited" }));
    const { containerId, result } = run("MSKU1234567");
    await expect(result).resolves.toMatchObject({ error: "maersk_providers_unavailable" });
    expect(h.parcelsEvents.mock.calls.at(-1)?.[1]).toEqual({
      trackingId: "MSKU1234567",
      done: true,
      attributes: { status: "LOAD" },
      states: [{ date: "", status: "", location: "", description: "" }],
    });
    expect(h.confirm.mock.calls.at(-1)?.[6]).toBe("no ETA from maersk_scraper");
    expect(steps(containerId)).toEqual([
      ["Maersk Puppeteer", "success", "LOAD"],
      ["Maersk public HTTP", "skip", "rate-limited — 6 h cooldown"],
    ]);
    expect(checkStatuses().at(-1)).toEqual(["maersk_public", "skipped", "rate_limited"]);
  });

  it("uses a Puppeteer ETA without events only when none is stored", async () => {
    h.maerskDirectAvailable = true;
    h.maerskDirect.mockResolvedValue(carrier({ eta: "2026-11-05" }));
    const fresh = run("MSKU1234567");
    await expect(fresh.result).resolves.toMatchObject({ success: true, lastStatus: null });
    expect(h.updates.at(-1)).toMatchObject({ eta: "2026-11-05", etaSource: "api" });
    expect(steps(fresh.containerId)).toEqual([["Maersk Puppeteer", "success", "got data"]]);
    expect(info).toHaveBeenCalledWith("[ContainerTracking] MSKU1234567 → maersk_scraper: status=?");

    const stored = run("MSKU1234567", "2026-11-01");
    await stored.result;
    expect(h.updates.at(-1)).not.toHaveProperty("eta");
  });

  it("continues past Maersk public events without status or ETA", async () => {
    h.maerskPublic.mockResolvedValue(carrier({ events: [anEvent] }));
    const { containerId, result } = run("MSKU1234567");
    await expect(result).resolves.toMatchObject({ error: "maersk_providers_unavailable" });
    expect(steps(containerId)).toEqual([
      ["Maersk Puppeteer", "skip", "Chrome not available in this environment"],
      ["Maersk public HTTP", "success", "got data"],
    ]);
    expect(h.confirm.mock.calls[0][6]).toBe("no ETA from maersk_public");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] MSKU1234567 → maersk_public: status=?");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] MSKU1234567: Maersk chain exhausted — preserving ETA=none");
  });
});

describe("CMA CGM API for leasing containers", () => {
  it("returns events without a status and reports when no ETA came back", async () => {
    h.cmaApiConfigured = true;
    h.cmaApi.mockResolvedValue(carrier({ events: [anEvent] }));
    const { containerId, result } = run("TCNU1234567");
    await expect(result).resolves.toMatchObject({ success: true, lastStatus: null });
    expect(steps(containerId)).toEqual([["CMA CGM API", "success", "got data"]]);
    expect(h.confirm.mock.calls[0][6]).toBe("CMA API: no ETA returned");
  });

  it("marks an error as a failure and a not-found as a skip", async () => {
    h.cmaApiConfigured = true;
    h.cmaApi.mockResolvedValueOnce(carrier({ success: false }));
    const failed = run("TCNU1234567");
    await failed.result;
    expect(steps(failed.containerId)).toEqual([["CMA CGM API", "fail", "not on CMA ship"]]);
    expect(checkStatuses()).toEqual([["cma_cgm_api", "error", null]]);
    expect(info).toHaveBeenCalledWith(
      "[ContainerTracking] TCNU1234567: CMA API — not on CMA ship (no data) — proceeding"
    );

    h.cmaApi.mockResolvedValueOnce(carrier({ success: false, noData: true, error: "not_found" }));
    const missing = run("TCNU1234567");
    await missing.result;
    expect(steps(missing.containerId)).toEqual([["CMA CGM API", "skip", "not_found"]]);
  });
});

describe("CMA container chain", () => {
  it("returns the official API's events without status or ETA", async () => {
    h.cmaApiConfigured = true;
    h.cmaApi.mockResolvedValue(carrier({ events: [anEvent] }));
    const { result } = run("CMAU1234567");
    await expect(result).resolves.toMatchObject({ success: true });
    expect(h.confirm.mock.calls[0][6]).toBe("no ETA from CMA CGM official API");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] CMAU1234567 → cma_cgm_api: status=? eta=none");
  });

  it("falls from the official API to the public endpoint", async () => {
    h.cmaApiConfigured = true;
    h.cmaPublicEnabled = true;
    h.cmaApi.mockResolvedValue(carrier({ success: false, error: "http_500" }));
    h.cmaPublic.mockResolvedValue(carrier({ events: [anEvent] }));
    const { result } = run("CMAU1234567");
    await expect(result).resolves.toMatchObject({ success: true });
    expect(checkStatuses()).toEqual([
      ["cma_cgm_api", "error", "http_500"],
      ["cma_public", "success", null],
    ]);
    expect(h.confirm.mock.calls[0][6]).toBe("no ETA from CMA public endpoint");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] CMAU1234567 → cma_public: status=?");
  });

  it("tries 17track after a blocked public endpoint and falls to the ParcelsApp API", async () => {
    h.cmaPublicEnabled = true;
    h.seventeenConfigured = true;
    h.cmaPublic.mockResolvedValue(carrier({ success: false, blocked: true, error: "captcha" }));
    h.seventeen.mockResolvedValueOnce(carrier({ success: false, noData: true }));
    await expect(run("CMAU1234567").result).resolves.toBe(API_RESULT);
    h.seventeen.mockResolvedValueOnce(carrier({ success: false, error: "quota" }));
    await run("CMAU1234567").result;
    expect(checkStatuses()).toEqual([
      ["cma_public", "blocked", "captcha"],
      ["17track", "no_data", null],
      ["cma_public", "blocked", "captcha"],
      ["17track", "error", "quota"],
    ]);
    expect(h.api.mock.calls[0][2]).toBeNull();

    h.seventeen.mockResolvedValueOnce(carrier());
    await expect(run("CMAU1234567").result).resolves.toMatchObject({ success: true });
    expect(h.confirm.mock.calls.at(-1)?.[6]).toBe("17track returned no ETA");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] CMAU1234567 → 17track (CMA): status=?");

    h.quota.mockResolvedValueOnce(false);
    h.seventeen.mockClear();
    await run("CMAU1234567").result;
    expect(h.seventeen).not.toHaveBeenCalled();
  });
});

describe("ParcelsApp scraper and 17track", () => {
  it("returns a scrape without status or ETA", async () => {
    h.scraperAvailable = true;
    h.scraper.mockResolvedValue({ success: true, shipment: { trackingId: "T", done: true } });
    const { containerId, result } = run("TCNU1234567");
    await expect(result).resolves.toMatchObject({ success: true, lastStatus: null, lastDescription: null });
    expect(steps(containerId)).toEqual([["Puppeteer scraper", "success", "got data"]]);
    expect(h.confirm.mock.calls[0][6]).toBe("no ETA derived from shipment states");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] TCNU1234567 → parcelsapp_scraper: status=?");
  });

  it("records a failed scrape, then 17track without status or ETA", async () => {
    h.scraperAvailable = true;
    h.seventeenConfigured = true;
    h.scraper.mockResolvedValue({ success: false });
    h.seventeen.mockResolvedValueOnce(carrier());
    const { containerId, result } = run("TCNU1234567");
    await expect(result).resolves.toMatchObject({ success: true });
    expect(steps(containerId)).toEqual([
      ["Puppeteer scraper", "fail", "no data"],
      ["17track API", "success", "got data"],
    ]);
    expect(warn).toHaveBeenCalledWith(
      "[ContainerTracking] TCNU1234567: scraper failed (undefined) — trying 17track..."
    );
    expect(h.confirm.mock.calls[0][6]).toBe("17track returned no ETA and no events with dates");
    expect(info).toHaveBeenCalledWith("[ContainerTracking] TCNU1234567 → 17track: status=?");

    h.seventeen.mockResolvedValueOnce(carrier({ success: false }));
    const failed = run("TCNU1234567");
    await expect(failed.result).resolves.toBe(API_RESULT);
    expect(steps(failed.containerId).at(-1)).toEqual(["17track API", "fail", "no data"]);
    expect(checkStatuses().at(-1)).toEqual(["17track", "error", null]);
  });
});
