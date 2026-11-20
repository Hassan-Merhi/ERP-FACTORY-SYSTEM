/**
 * Factory container tracking fallback chain, step 3 (CMA CGM API for leasing
 * boxes, Puppeteer scraper, 17track, ParcelsApp API with a no-hint retry),
 * against a rolled-back factory container. The carrier APIs and the scraper
 * are outbound providers and are mocked at their module boundary; tracking
 * checks, events and container updates are written for real.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CarrierTrackResult } from "../server/lib/trackingProviders/types";

const h = vi.hoisted(() => ({
  cmaConfigured: false,
  cma: vi.fn(),
  scraperAvailable: false,
  scraper: vi.fn(),
  seventeenConfigured: false,
  seventeenLimit: 1000,
  seventeen: vi.fn(),
  parcels: vi.fn(),
}));
vi.mock("../server/lib/trackingProviders/cmaCgmApiProvider", () => ({
  isConfigured: () => h.cmaConfigured,
  track: (...a: unknown[]) => h.cma(...a),
}));
vi.mock("../server/lib/parcelsAppScraper", () => ({
  isScraperAvailable: () => h.scraperAvailable,
  scrapeTracking: (...a: unknown[]) => h.scraper(...a),
}));
vi.mock("../server/lib/trackingProviders/seventeenTrackProvider", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/trackingProviders/seventeenTrackProvider")>()),
  isConfigured: () => h.seventeenConfigured,
  getMonthlyLimit: () => h.seventeenLimit,
  track: (...a: unknown[]) => h.seventeen(...a),
}));
vi.mock("../server/lib/parcelsAppClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/parcelsAppClient")>()),
  trackContainer: (...a: unknown[]) => h.parcels(...a),
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";
import { trackViaParcelsAppStep3 } from "../server/services/factory-container-tracking/trackViaParcelsAppStep3";

const NOW = new Date("2026-11-01T10:00:00Z");
const PREFIXES = { CMA_PREFIXES: /^CMAU/, MAERSK_PREFIXES_FC: /^MSKU/ };

afterEach(() => {
  h.cmaConfigured = false;
  h.scraperAvailable = false;
  h.seventeenConfigured = false;
  h.seventeenLimit = 1000;
  for (const fn of [h.cma, h.scraper, h.seventeen, h.parcels]) fn.mockReset();
  delete process.env.PARCELSAPP_API_KEY;
});

const carrier = (patch: Partial<CarrierTrackResult>): CarrierTrackResult => ({
  success: true,
  provider: "x",
  carrier: null,
  containerNumber: "TGHU1234567",
  latestStatus: null,
  latestLocation: null,
  latestEventDate: null,
  latestDescription: null,
  eta: null,
  events: [],
  raw: null,
  ...patch,
});
const event = { date: new Date("2026-10-30T00:00:00Z"), status: "Loaded", location: "Mombasa", description: "Loaded" };

async function container(world: FactoryWorld) {
  return world.one(
    `INSERT INTO factory_containers (company_id, container_number, status, arrival_date)
     VALUES ($1, $2, 'IN_TRANSIT', '2026-12-01') RETURNING id`,
    [world.companyId, `${world.tag}TG`]
  );
}

const step = (
  id: number,
  opts: { eta?: string | null; hint?: string | null; detected?: string | null; number?: string } = {}
) =>
  trackViaParcelsAppStep3(
    PREFIXES,
    id,
    opts.number ?? "TGHU1234567",
    opts.detected === undefined ? "OTHER" : opts.detected,
    NOW,
    opts.eta === undefined ? null : opts.eta,
    "CD",
    opts.hint ?? null
  );

const row = async (world: FactoryWorld, id: number) =>
  (
    await world.q(
      `SELECT tracking_provider, tracking_last_status, tracking_error, arrival_date::text AS eta FROM factory_containers WHERE id = $1`,
      [id]
    )
  )[0];
const checks = async (world: FactoryWorld, id: number) =>
  (
    await world.q(
      `SELECT provider, status FROM factory_container_tracking_checks WHERE container_id = $1 ORDER BY id`,
      [id]
    )
  ).map((r) => `${r.provider}:${r.status}`);

describe("CMA CGM API for leasing containers", () => {
  it("records events from a status-less CMA answer and keeps the current ETA", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      h.cmaConfigured = true;
      h.cma.mockResolvedValueOnce(carrier({ events: [event] }));
      const result = await step(id, { eta: null });
      expect(result).toMatchObject({ done: true, value: { success: true, lastStatus: null } });
      expect(await row(world, id)).toMatchObject({ tracking_provider: "cma_cgm_api", eta: "2026-12-01" });
      expect(await checks(world, id)).toEqual(["cma_cgm_api:success"]);
    }));

  it("skips CMA and Maersk boxes and falls through when CMA has no data or errors", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      h.cmaConfigured = true;
      expect(await step(id, { number: "CMAU1234567" })).toMatchObject({ done: true, value: { success: false } });
      expect(h.cma).not.toHaveBeenCalled();
      h.cma
        .mockResolvedValueOnce(carrier({ success: false, noData: true }))
        .mockResolvedValueOnce(carrier({ success: false, error: "401" }))
        .mockResolvedValueOnce(carrier({ success: true }));
      for (let i = 0; i < 3; i++) {
        expect(await step(id)).toMatchObject({ value: { error: "No tracking provider configured" } });
      }
      expect(await checks(world, id)).toEqual(["cma_cgm_api:no_data", "cma_cgm_api:error", "cma_cgm_api:success"]);
    }));
});

describe("scraper and 17track", () => {
  it("uses a scraped shipment and falls through when the scraper is blocked or empty", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      h.scraperAvailable = true;
      h.scraper
        .mockResolvedValueOnce({ success: false, blocked: true })
        .mockResolvedValueOnce({ success: false, error: "timeout" })
        .mockResolvedValueOnce({ success: true, shipment: { states: [] } });
      expect((await step(id)).done).toBe(true);
      expect((await step(id)).done).toBe(true);
      const scraped = await step(id, { eta: "2026-12-24" });
      expect(scraped).toMatchObject({ done: true, value: { success: true, lastDescription: null } });
      expect(await row(world, id)).toMatchObject({ tracking_provider: "parcelsapp_scraper", eta: "2026-12-24" });
    }));

  it("uses 17track within quota, falls through on failure and skips it when the quota is spent", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      h.seventeenConfigured = true;
      h.seventeen
        .mockResolvedValueOnce(carrier({ success: false, noData: true }))
        .mockResolvedValueOnce(carrier({ success: false, error: "bad key", raw: { code: 401 } }))
        .mockResolvedValueOnce(carrier({ latestStatus: "Discharged", eta: "2026-11-20", events: [event] }))
        .mockResolvedValueOnce(carrier({}));
      await step(id);
      await step(id);
      expect(await step(id)).toMatchObject({ value: { success: true, lastStatus: "Discharged" } });
      expect(await row(world, id)).toMatchObject({ tracking_provider: "17track", eta: "2026-11-20" });
      expect(await step(id)).toMatchObject({ value: { success: true, lastStatus: null } });

      h.seventeenLimit = 0;
      await step(id);
      expect(h.seventeen).toHaveBeenCalledTimes(4);
    }));
});

describe("ParcelsApp API", () => {
  it("retries a timed-out hinted lookup without the hint and returns the shipment for the caller to save", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      process.env.PARCELSAPP_API_KEY = "test-key";
      const shipment = { states: [{ description: "Arrived", date: "2026-10-31", location: "Matadi" }] };
      h.parcels
        .mockResolvedValueOnce({ success: false, timedOut: true, rawResponse: null })
        .mockResolvedValueOnce({ success: true, shipment, rawResponse: {} });
      const result = await step(id, { detected: "MSC" });
      expect(h.parcels.mock.calls.map((call) => call[2])).toEqual(["MSC", undefined]);
      expect(result).toMatchObject({ done: false, lastDescription: "Arrived" });
      expect(await checks(world, id)).toEqual(["parcelsapp:timeout", "parcelsapp_retry_no_hint:success"]);
    }));

  it("reports a carrier timeout, a failed retry and plain errors", () =>
    withFactoryWorld(async (world) => {
      const id = await container(world);
      process.env.PARCELSAPP_API_KEY = "test-key";
      h.parcels
        .mockResolvedValueOnce({ success: false, timedOut: true })
        .mockResolvedValueOnce({ success: false, timedOut: true })
        .mockResolvedValueOnce({ success: false, error: "quota" })
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true, shipment: null });
      expect(await step(id, { hint: "CMA" })).toMatchObject({ value: { error: "Carrier timed out (dest=CD)" } });
      expect(await step(id, { detected: null })).toMatchObject({ value: { error: "quota" } });
      expect(await step(id, { detected: null })).toMatchObject({ value: { error: "Tracking failed" } });
      expect(await step(id, { detected: null })).toMatchObject({ value: { error: "Tracking failed" } });
      expect(await row(world, id)).toMatchObject({
        tracking_provider: "parcelsapp",
        tracking_error: "Tracking failed",
      });
    }));
});
