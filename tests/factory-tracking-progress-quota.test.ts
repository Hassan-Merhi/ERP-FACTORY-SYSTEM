/**
 * Factory container tracking's live helpers: the progress steps the tracking
 * route polls, status and container-number checks, and the 17track quota count
 * read from the ERP checks table.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const h = vi.hoisted(() => ({ scraper: false, httpScraper: false, maersk: false, configured: false, limit: 2 }));
vi.mock("../server/lib/parcelsAppScraper", () => ({ isScraperAvailable: () => h.scraper }));
vi.mock("../server/lib/httpTrackingScraper", () => ({ isHttpScraperAvailable: () => h.httpScraper }));
vi.mock("../server/lib/maerskDirectScraper", () => ({ isMaerskDirectScraperAvailable: () => h.maersk }));
vi.mock("../server/lib/trackingProviders/seventeenTrackProvider", () => ({
  isConfigured: () => h.configured,
  getMonthlyLimit: () => h.limit,
}));

import { db } from "../server/db";
import {
  anyProviderConfigured,
  check17trackQuota,
  ep,
  getFactoryTrackingProgress,
  initProgress,
  isInactiveStatus,
  isValidContainerNumber,
} from "../server/services/factory-container-tracking/progress-quota";

const env = { ...process.env };

beforeEach(() => {
  Object.assign(h, { scraper: false, httpScraper: false, maersk: false, configured: false, limit: 2 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  process.env = { ...env };
});

describe("factory tracking progress", () => {
  it("records one step per provider, updating it in place, and forgets it after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T08:00:00Z"));
    expect(getFactoryTrackingProgress(9001)).toEqual([]);
    initProgress(9001);
    ep(9001, "Maersk", "running");
    ep(9001, "ParcelsApp API", "skip", "no key");
    vi.setSystemTime(new Date("2026-10-20T08:00:05Z"));
    ep(9001, "Maersk", "success", "Discharged");
    expect(getFactoryTrackingProgress(9001)).toEqual([
      { provider: "Maersk", status: "success", detail: "Discharged", ts: Date.parse("2026-10-20T08:00:05Z") },
      { provider: "ParcelsApp API", status: "skip", detail: "no key", ts: Date.parse("2026-10-20T08:00:00Z") },
    ]);
    vi.advanceTimersByTime(10 * 60 * 1000 - 1);
    expect(getFactoryTrackingProgress(9001)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(getFactoryTrackingProgress(9001)).toEqual([]);
  });

  it("starts a progress list for a container nobody initialised", () => {
    ep(9002, "17track", "fail", "quota");
    expect(getFactoryTrackingProgress(9002)).toMatchObject([{ provider: "17track", status: "fail", detail: "quota" }]);
  });
});

describe("factory tracking checks", () => {
  it("treats offloaded, closed and completed containers as inactive in any case", () => {
    expect(["OFFLOADED", "Closed", "completed"].map(isInactiveStatus)).toEqual([true, true, true]);
    expect(["PENDING", "in_transit", "offload"].map(isInactiveStatus)).toEqual([false, false, false]);
  });

  it("accepts four letters and seven digits, ignoring case and surrounding spaces", () => {
    expect(isValidContainerNumber(" msku1234567 ")).toBe(true);
    for (const bad of [null, undefined, "", "MSKU123456", "MSK11234567", "MSKU12345678"]) {
      expect(isValidContainerNumber(bad)).toBe(false);
    }
  });

  it("reports whether any tracking provider is configured", () => {
    delete process.env.PARCELSAPP_API_KEY;
    expect(anyProviderConfigured()).toBe(false);
    for (const key of ["configured", "scraper", "httpScraper", "maersk"] as const) {
      Object.assign(h, { configured: false, scraper: false, httpScraper: false, maersk: false, [key]: true });
      expect(anyProviderConfigured()).toBe(true);
    }
    Object.assign(h, { configured: false, scraper: false, httpScraper: false, maersk: false });
    process.env.PARCELSAPP_API_KEY = "key";
    expect(anyProviderConfigured()).toBe(true);
  });
});

describe("check17trackQuota", () => {
  it("counts this month's 17track checks against the monthly limit", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM container_tracking_checks");
      const tag = `FPQ${process.pid}`;
      const companyId = (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag]))
        .rows[0].id;
      const supplierId = (
        await client.query(
          "INSERT INTO suppliers(company_id,code,legal_name,email) VALUES($1,$2,'V','v@x.test') RETURNING id",
          [companyId, `${tag}-S`]
        )
      ).rows[0].id;
      const containerId = (
        await client.query(
          "INSERT INTO containers(company_id,container_number,supplier_id,import_date) VALUES($1,$2,$3,'2026-09-01') RETURNING id",
          [companyId, `FPQU${String(process.pid % 10_000_000).padStart(7, "0")}`, supplierId]
        )
      ).rows[0].id;
      const check = (provider: string, at: string) =>
        client.query(
          `INSERT INTO container_tracking_checks(container_id,provider,status,checked_at) VALUES($1,$2,'success',${at})`,
          [containerId, provider]
        );
      await check("17track", "date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' - interval '1 second'");
      await check("parcelsapp", "now()");
      await check("17track", "now()");
      expect(await check17trackQuota()).toBe(true);
      await check("17track", "now()");
      expect(await check17trackQuota()).toBe(false);
    });
  });

  it("allows tracking when the count cannot be read", async () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });
    expect(await check17trackQuota()).toBe(true);
  });
});
