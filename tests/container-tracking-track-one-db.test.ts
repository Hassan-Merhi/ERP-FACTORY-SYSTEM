/**
 * ERP container tracking against PostgreSQL: one container through the direct
 * provider chain, the stored events and checks, ETA resolution and the quota
 * counters. External providers are stubbed; the container rows are real, in a
 * rolled-back transaction that every database call is routed to.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CarrierTrackResult } from "../server/lib/trackingProviders/types";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const h = vi.hoisted(() => ({
  direct: [] as Array<() => Promise<unknown>>,
  carrier: "MAERSK" as string | null,
  jsonCargo: vi.fn(),
  parcels: vi.fn(),
  scraper: false,
  httpScraper: false,
  maersk: false,
}));

vi.mock("../server/lib/trackingProviders/providerResolver", () => ({
  resolveProvider: () => ({ detectedCarrier: h.carrier, tryDirect: h.direct }),
}));
vi.mock("../server/services/jsonCargoTrackingService", () => ({
  refreshContainerEta: (...args: unknown[]) => h.jsonCargo(...args),
}));
vi.mock("../server/services/container-tracking/parcels-app", () => ({
  trackViaParcelsApp: (...args: unknown[]) => h.parcels(...args),
}));
vi.mock("../server/lib/parcelsAppScraper", () => ({ isScraperAvailable: () => h.scraper }));
vi.mock("../server/lib/httpTrackingScraper", () => ({ isHttpScraperAvailable: () => h.httpScraper }));
vi.mock("../server/lib/maerskDirectScraper", () => ({ isMaerskDirectScraperAvailable: () => h.maersk }));

import { logger } from "../server/lib/logger";
import { trackOneContainer } from "../server/services/container-tracking/track-one";
import {
  backfillEtaFromEvents,
  saveParcelsAppEvents,
  saveTrackingCheck,
} from "../server/services/container-tracking/persistence";
import { resolveEtaFromProvider, resolveEtaFromShipment } from "../server/services/container-tracking/eta";
import {
  anyProviderConfigured,
  check17trackQuota,
  checkParcelsAppQuota,
  deriveFallbackReason,
  get17trackUsageStats,
  getParcelsAppUsageStats,
  setSchedulerMeta,
} from "../server/services/container-tracking/quotas";
import {
  ep,
  getTrackingProgress,
  initTrackingProgress,
  isInactiveStatus,
  isValidContainerNumber,
} from "../server/services/container-tracking/validation-progress";

let seq = 0;
const env = { ...process.env };

async function container(
  client: PoolClient,
  number: string,
  extra: { eta?: string | null; carrier?: string | null } = {}
) {
  const tag = `CTR${process.pid}${++seq}`;
  const companyId = Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
  );
  const supplierId = Number(
    (
      await client.query(
        "INSERT INTO suppliers(company_id,code,legal_name,email) VALUES($1,$2,'V','v@x.test') RETURNING id",
        [companyId, `${tag}-S`]
      )
    ).rows[0].id
  );
  return Number(
    (
      await client.query(
        `INSERT INTO containers(company_id,container_number,supplier_id,import_date,eta,tracking_carrier_hint)
         VALUES($1,$2,$3,'2026-09-01',$4,$5) RETURNING id`,
        [companyId, number, supplierId, extra.eta ?? null, extra.carrier ?? null]
      )
    ).rows[0].id
  );
}

async function row(client: PoolClient, id: number) {
  return (
    await client.query(
      `SELECT eta::text, eta_source, tracking_last_status, tracking_last_description, tracking_error, tracking_provider,
              tracking_detected_carrier, tracking_fallback_used, tracking_last_checked_at IS NOT NULL AS checked,
              tracking_last_skip_reason, tracking_next_check_at
         FROM containers WHERE id=$1`,
      [id]
    )
  ).rows[0];
}

const checks = async (client: PoolClient, id: number) =>
  (
    await client.query(
      "SELECT provider, status, error_message FROM container_tracking_checks WHERE container_id=$1 ORDER BY id",
      [id]
    )
  ).rows;
const events = async (client: PoolClient, id: number) =>
  (
    await client.query(
      "SELECT provider, event_status, event_location, event_time IS NOT NULL AS dated FROM container_tracking_events WHERE container_id=$1 ORDER BY id",
      [id]
    )
  ).rows;

const result = (over: Partial<CarrierTrackResult>): CarrierTrackResult => ({
  success: false,
  provider: "maersk_public",
  carrier: "MAERSK",
  containerNumber: "MSKU1234567",
  latestStatus: null,
  latestLocation: null,
  latestEventDate: null,
  latestDescription: null,
  eta: null,
  events: [],
  raw: null,
  ...over,
});

beforeEach(() => {
  h.direct = [];
  h.carrier = "MAERSK";
  h.jsonCargo.mockReset().mockResolvedValue({ status: "skipped_recent", message: "fresh", newEta: null });
  h.parcels.mockReset().mockResolvedValue({ success: false, fromParcels: true });
  h.scraper = false;
  h.httpScraper = false;
  h.maersk = false;
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...env };
});

describe("trackOneContainer", () => {
  it("skips an invalid container number without calling any provider", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "BAD-123");
      const outcome = await trackOneContainer(id, "BAD-123");
      expect(outcome).toMatchObject({
        success: false,
        lastStatus: null,
        error: 'Invalid container number format: "BAD-123" (must be 4 letters + 7 digits)',
      });
      expect(await checks(client, id)).toEqual([
        { provider: "skipped", status: "invalid_container_number", error_message: outcome.error },
      ]);
      expect(await row(client, id)).toMatchObject({ tracking_error: outcome.error, checked: true });
      expect(h.parcels).not.toHaveBeenCalled();
    });
  });

  it("saves the first successful direct provider's events, status and ETA", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "MSKU1234567", { eta: "2026-10-30" });
      const first = vi.fn(async () => result({ provider: "maersk_api", notConfigured: true, error: "no key" }));
      const second = vi.fn(async () => result({ provider: "maersk_public", blocked: true }));
      const third = vi.fn(async () =>
        result({
          success: true,
          provider: "maersk_scraper",
          latestStatus: "Discharged",
          latestLocation: "Walvis Bay",
          latestDescription: "Discharged at Walvis Bay",
          latestEventDate: new Date("2026-10-19T10:00:00Z"),
          eta: "2026-11-02",
          events: [
            { date: new Date("2026-10-19T10:00:00Z"), status: "Discharged", location: "Walvis Bay", description: null },
            { date: new Date("2026-10-19T10:00:00Z"), status: "Discharged", location: "dup", description: null },
            { date: null, status: "Planned", location: null, description: null },
          ],
          raw: { ok: true },
        })
      );
      const unused = vi.fn();
      h.direct = [first, second, third, unused];
      const outcome = await trackOneContainer(id, "MSKU1234567");
      expect(outcome).toMatchObject({
        success: true,
        lastStatus: "Discharged",
        lastLocation: "Walvis Bay",
        lastDescription: "Discharged at Walvis Bay",
        error: null,
      });
      expect(unused).not.toHaveBeenCalled();
      expect(await checks(client, id)).toEqual([
        { provider: "maersk_api", status: "error", error_message: "no key" },
        { provider: "maersk_public", status: "blocked", error_message: "maersk_public_blocked" },
        { provider: "maersk_scraper", status: "success", error_message: null },
      ]);
      expect(await events(client, id)).toEqual([
        { provider: "maersk_scraper", event_status: "Discharged", event_location: "Walvis Bay", dated: true },
        { provider: "maersk_scraper", event_status: "Planned", event_location: null, dated: false },
      ]);
      expect(await row(client, id)).toMatchObject({
        eta: "2026-11-02",
        eta_source: "api",
        tracking_last_status: "Discharged",
        tracking_provider: "maersk_scraper",
        tracking_detected_carrier: "MAERSK",
        tracking_fallback_used: false,
        tracking_error: null,
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("[ETA] MSKU1234567 provider=maersk_scraper old=2026-10-30")
      );
    });
  });

  it("keeps the stored ETA when the provider has none and refreshes it from JSONCargo first", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "MSKU7654321", { eta: "2026-10-30", carrier: "Maersk" });
      h.jsonCargo.mockResolvedValue({ status: "updated", message: "eta changed", newEta: "2026-11-04" });
      h.direct = [async () => result({ success: true, provider: "maersk_public", latestStatus: "In transit" })];
      await trackOneContainer(id, "MSKU7654321");
      expect(h.jsonCargo).toHaveBeenCalledWith(id);
      expect(await row(client, id)).toMatchObject({
        eta: "2026-11-04",
        eta_source: "manual",
        tracking_last_status: "In transit",
      });
      expect(logger.info).toHaveBeenCalledWith("[ContainerTracking] MSKU7654321: jsoncargo → updated (eta changed)");
    });
  });

  it("records no ETA at all when neither the provider nor the row has one", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "MSKU1111111", { carrier: "MSC" });
      h.jsonCargo.mockRejectedValue(new Error("jsoncargo down"));
      h.direct = [async () => result({ success: true, provider: "maersk_public" })];
      await trackOneContainer(id, "MSKU1111111");
      // Nothing is written: the ETA stays empty and the source keeps its column default.
      expect(await row(client, id)).toMatchObject({ eta: null, eta_source: "manual" });
      expect(logger.warn).toHaveBeenCalledWith("[ContainerTracking] MSKU1111111: jsoncargo pre-check error —", {
        error: "jsoncargo down",
      });
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining("NO UPDATE — provider returned no ETA and no events with dates")
      );
    });
  });

  it("falls back to ParcelsApp with the last direct failure reason", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "MSKU2222222", { eta: "2026-12-01" });
      h.direct = [async () => result({ provider: "maersk_public", noData: true, error: "nothing" })];
      const outcome = await trackOneContainer(id, "MSKU2222222", "Zambia");
      expect(outcome).toEqual({ success: false, fromParcels: true });
      expect(h.parcels).toHaveBeenCalledWith(
        id,
        "MSKU2222222",
        "MAERSK",
        "maersk_public_no_data",
        expect.any(Date),
        "2026-12-01",
        null,
        "Zambia"
      );
      expect(await checks(client, id)).toEqual([
        { provider: "maersk_public", status: "no_data", error_message: "nothing" },
      ]);

      h.direct = [];
      await trackOneContainer(id, "MSKU2222222");
      expect(h.parcels.mock.calls[1][3]).toBeNull();
    });
  });
});

describe("tracking persistence and ETA helpers", () => {
  it("stores ParcelsApp events and backfills a missing ETA from the newest one", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "CMAU1234567");
      await saveParcelsAppEvents(id, { trackingId: "CMAU1234567", done: true });
      await saveParcelsAppEvents(id, {
        trackingId: "CMAU1234567",
        done: true,
        states: [
          { date: "2026-10-05T00:00:00Z", status: "Gate in", location: "Shanghai" },
          { date: "2026-10-12T00:00:00Z", status: "Loaded" },
          { date: "garbage", status: "Unknown" },
        ],
      });
      expect(await events(client, id)).toEqual([
        { provider: "parcelsapp", event_status: "Gate in", event_location: "Shanghai", dated: true },
        { provider: "parcelsapp", event_status: "Loaded", event_location: null, dated: true },
        { provider: "parcelsapp", event_status: "Unknown", event_location: null, dated: false },
      ]);
      await backfillEtaFromEvents(id);
      expect(await row(client, id)).toMatchObject({ eta: "2026-10-12", eta_source: "event" });

      // An ETA that is already set is left alone.
      await client.query("UPDATE containers SET eta='2026-12-25' WHERE id=$1", [id]);
      await backfillEtaFromEvents(id);
      expect((await row(client, id)).eta).toBe("2026-12-25");

      const empty = await container(client, "CMAU7654321");
      await backfillEtaFromEvents(empty);
      expect((await row(client, empty)).eta).toBeNull();
    });
  });

  it("logs instead of failing when a check or event cannot be saved", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("SAVEPOINT bad_check");
      await saveTrackingCheck(Number.NaN, "parcelsapp", "success", null, null);
      await client.query("ROLLBACK TO SAVEPOINT bad_check");
      expect(logger.warn).toHaveBeenCalledWith("[ContainerTracking] Check record save warn:", {
        error: expect.any(String),
      });

      await client.query("SAVEPOINT bad_event");
      await saveParcelsAppEvents(Number.NaN, {
        trackingId: "X",
        done: true,
        states: [{ date: "2026-10-01", status: "x" }],
      });
      await client.query("ROLLBACK TO SAVEPOINT bad_event");
      expect(logger.warn).toHaveBeenCalledWith("[ContainerTracking] ParcelsApp event save warn:", {
        error: expect.any(String),
      });
    });
  });

  it("prefers the provider ETA, then the stored one", () => {
    expect(resolveEtaFromProvider("2026-11-01", [], "2026-10-01")).toEqual({ eta: "2026-11-01", source: "api" });
    expect(resolveEtaFromProvider(null, [], "2026-10-01")).toEqual({ eta: "2026-10-01", source: "manual" });
    expect(resolveEtaFromProvider(null, undefined, null)).toEqual({ eta: null, source: null });
    expect(resolveEtaFromShipment({ trackingId: "x", done: true, eta: "2026-11-09" }, "2026-10-01")).toEqual({
      eta: "2026-11-09",
      source: "api",
    });
    expect(resolveEtaFromShipment({ trackingId: "x", done: true }, "2026-10-01")).toEqual({
      eta: "2026-10-01",
      source: "manual",
    });
    expect(resolveEtaFromShipment({ trackingId: "x", done: true }, null)).toEqual({ eta: null, source: null });
  });
});

describe("tracking quotas and scheduler metadata", () => {
  it("counts this month's billable ParcelsApp and 17track checks", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM container_tracking_checks");
      const id = await container(client, "MSKU3333333");
      for (const [provider, status, when] of [
        ["parcelsapp", "success", "NOW()"],
        ["parcelsapp", "error", "NOW()"],
        ["parcelsapp", "timeout", "NOW()"],
        ["parcelsapp", "skipped", "NOW()"],
        ["parcelsapp", "success", "NOW() - INTERVAL '40 days'"],
        ["17track", "success", "NOW()"],
        ["17track", "timeout", "NOW()"],
      ]) {
        await client.query(
          `INSERT INTO container_tracking_checks(container_id,provider,status,checked_at) VALUES($1,$2,$3,${when})`,
          [id, provider, status]
        );
      }
      process.env.PARCELSAPP_MONTHLY_LIMIT = "3";
      process.env.SEVENTEENTRACK_MONTHLY_LIMIT = "2";
      // The 40-day-old row belongs to an earlier month.
      await expect(getParcelsAppUsageStats()).resolves.toEqual({ used: 3, limit: 3 });
      await expect(checkParcelsAppQuota()).resolves.toBe(false);
      await expect(get17trackUsageStats()).resolves.toEqual({ used: 1, limit: 2 });
      await expect(check17trackQuota()).resolves.toBe(true);

      delete process.env.PARCELSAPP_MONTHLY_LIMIT;
      await expect(getParcelsAppUsageStats()).resolves.toMatchObject({ limit: 500 });
      await expect(checkParcelsAppQuota()).resolves.toBe(true);
    });
  });

  it("treats an unreadable quota as unused", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("SAVEPOINT q");
      await client.query("ALTER TABLE container_tracking_checks RENAME TO container_tracking_checks_hidden");
      await expect(getParcelsAppUsageStats()).resolves.toEqual({ used: 0, limit: 500 });
      await client.query("ROLLBACK TO SAVEPOINT q");
      await client.query("SAVEPOINT q");
      await client.query("ALTER TABLE container_tracking_checks RENAME TO container_tracking_checks_hidden");
      await expect(get17trackUsageStats()).resolves.toMatchObject({ used: 0 });
      await client.query("ROLLBACK TO SAVEPOINT q");
      expect(logger.warn).toHaveBeenCalledWith("[ContainerTracking] Could not read quota from DB:", {
        error: expect.any(String),
      });
    });
  });

  it("stores the skip reason and optionally the next check time", async () => {
    await withRolledBackPool(async (client) => {
      const id = await container(client, "MSKU4444444");
      await setSchedulerMeta(id, "skipped_recent", new Date("2026-11-01T00:00:00Z"));
      expect(await row(client, id)).toMatchObject({
        tracking_last_skip_reason: "skipped_recent",
        tracking_next_check_at: expect.any(Date),
      });
      await setSchedulerMeta(id, null, undefined);
      expect(await row(client, id)).toMatchObject({
        tracking_last_skip_reason: null,
        tracking_next_check_at: expect.any(Date),
      });
      await setSchedulerMeta(id, "x", null);
      expect((await row(client, id)).tracking_next_check_at).toBeNull();

      await client.query("SAVEPOINT meta");
      await client.query("ALTER TABLE containers RENAME COLUMN tracking_last_skip_reason TO tlsr_hidden");
      await setSchedulerMeta(id, "y", undefined);
      await client.query("ROLLBACK TO SAVEPOINT meta");
      expect(logger.warn).toHaveBeenCalledWith("[ContainerTracking] setSchedulerMeta warn:", {
        error: expect.any(String),
      });
    });
  });

  it("knows when any provider is configured and names fallback reasons", () => {
    delete process.env.PARCELSAPP_API_KEY;
    delete process.env.SEVENTEENTRACK_API_KEY;
    expect(anyProviderConfigured()).toBe(false);
    h.maersk = true;
    expect(anyProviderConfigured()).toBe(true);
    h.maersk = false;
    h.httpScraper = true;
    expect(anyProviderConfigured()).toBe(true);
    h.httpScraper = false;
    h.scraper = true;
    expect(anyProviderConfigured()).toBe(true);
    h.scraper = false;
    process.env.SEVENTEENTRACK_API_KEY = "x";
    expect(anyProviderConfigured()).toBe(true);
    delete process.env.SEVENTEENTRACK_API_KEY;
    process.env.PARCELSAPP_API_KEY = "x";
    expect(anyProviderConfigured()).toBe(true);

    expect(deriveFallbackReason(result({ provider: "p", notConfigured: true, blocked: true }))).toBe(
      "p_not_configured"
    );
    expect(deriveFallbackReason(result({ provider: "p", blocked: true, noData: true }))).toBe("p_blocked");
    expect(deriveFallbackReason(result({ provider: "p", noData: true }))).toBe("p_no_data");
    expect(deriveFallbackReason(result({ provider: "p" }))).toBe("p_error");
  });
});

describe("validation and progress", () => {
  it("validates container numbers and inactive statuses", () => {
    expect(isValidContainerNumber(" msku1234567 ")).toBe(true);
    expect(isValidContainerNumber("MSKU123456")).toBe(false);
    expect(isValidContainerNumber(null)).toBe(false);
    expect(isInactiveStatus("Offloaded")).toBe(true);
    expect(isInactiveStatus("COMPLETED")).toBe(true);
    expect(isInactiveStatus("OTW")).toBe(false);
  });

  it("records progress steps, replacing a running step in place, and purges after ten minutes", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    try {
      expect(getTrackingProgress(901)).toEqual([]);
      ep(901, "early", "running");
      expect(getTrackingProgress(901)).toHaveLength(1);
      initTrackingProgress(901);
      ep(901, "maersk", "running");
      ep(901, "maersk", "fail", "blocked");
      ep(901, "maersk", "running");
      ep(901, "parcels", "success", null);
      expect(getTrackingProgress(901).map((step) => [step.label, step.status, step.detail])).toEqual([
        ["maersk", "fail", "blocked"],
        ["maersk", "running", null],
        ["parcels", "success", null],
      ]);
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(getTrackingProgress(901)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
