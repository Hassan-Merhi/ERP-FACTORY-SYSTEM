/**
 * The ERP container tracker's last-resort ParcelsApp API step against
 * PostgreSQL. The ParcelsApp HTTP call is stubbed; quota counting, check rows,
 * events and the container update are real, in a rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const track = vi.hoisted(() => vi.fn());
vi.mock("../server/lib/parcelsAppClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/parcelsAppClient")>()),
  trackContainer: (...args: unknown[]) => track(...args),
}));

import { logger } from "../server/lib/logger";
import { trackViaParcelsAppApi } from "../server/services/container-tracking/parcels-app-api";
import { getTrackingProgress, initTrackingProgress } from "../server/services/container-tracking/validation-progress";

let seq = 0;
const env = { ...process.env };
const NOW = new Date("2026-10-20T12:00:00Z");

async function container(client: PoolClient, eta: string | null = null) {
  const tag = `CPA${process.pid}${++seq}`;
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
  const id = Number(
    (
      await client.query(
        "INSERT INTO containers(company_id,container_number,supplier_id,import_date,eta) VALUES($1,$2,$3,'2026-09-01',$4) RETURNING id",
        [
          companyId,
          `CPAU${String(process.pid % 1000).padStart(3, "0")}${String(seq).padStart(4, "0")}`,
          supplierId,
          eta,
        ]
      )
    ).rows[0].id
  );
  initTrackingProgress(id);
  return id;
}

const row = async (client: PoolClient, id: number) =>
  (
    await client.query(
      `SELECT eta::text, eta_source, tracking_last_status, tracking_last_description, tracking_error, tracking_provider,
              tracking_detected_carrier, tracking_fallback_used, tracking_fallback_reason, tracking_last_event_date
         FROM containers WHERE id=$1`,
      [id]
    )
  ).rows[0];
const checks = async (client: PoolClient, id: number) =>
  (
    await client.query(
      "SELECT provider, status, error_message FROM container_tracking_checks WHERE container_id=$1 ORDER BY id",
      [id]
    )
  ).rows;
const progress = (id: number) => getTrackingProgress(id).map((step) => [step.status, step.detail]);

beforeEach(() => {
  track.mockReset();
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
  process.env = { ...env };
});

describe("trackViaParcelsAppApi", () => {
  it("records that no provider is configured without a key", async () => {
    delete process.env.PARCELSAPP_API_KEY;
    await withRolledBackPool(async (client) => {
      const id = await container(client);
      const outcome = await trackViaParcelsAppApi(id, "MSKU1234567", "MAERSK", "maersk_public_blocked", NOW, null);
      expect(outcome).toEqual({
        success: false,
        lastStatus: null,
        lastLocation: null,
        lastDescription: null,
        lastCheckedAt: NOW,
        error: "No tracking provider configured (scraper unavailable, 17track not set, ParcelsApp key missing)",
      });
      expect(await row(client, id)).toMatchObject({
        tracking_error: outcome.error,
        tracking_detected_carrier: "MAERSK",
        tracking_fallback_used: true,
        tracking_fallback_reason: "maersk_public_blocked",
      });
      expect(progress(id)).toEqual([["skip", "API key not configured"]]);
      expect(track).not.toHaveBeenCalled();
    });
  });

  it("stops when this month's quota is used up", async () => {
    process.env.PARCELSAPP_API_KEY = "key";
    process.env.PARCELSAPP_MONTHLY_LIMIT = "1";
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM container_tracking_checks");
      const id = await container(client);
      await client.query(
        "INSERT INTO container_tracking_checks(container_id,provider,status,checked_at) VALUES($1,'parcelsapp','success',NOW())",
        [id]
      );
      const outcome = await trackViaParcelsAppApi(id, "MSKU1234567", null, null, NOW, null);
      expect(outcome.error).toBe("ParcelsApp API quota used (1/1) — all providers exhausted");
      expect((await checks(client, id)).at(-1)).toEqual({
        provider: "skipped",
        status: "skipped_quota",
        error_message: outcome.error,
      });
      expect(await row(client, id)).toMatchObject({
        tracking_fallback_used: false,
        tracking_fallback_reason: "parcelsapp_quota_exhausted",
      });
      expect(progress(id)).toEqual([["skip", "quota exhausted this month"]]);

      await trackViaParcelsAppApi(id, "MSKU1234567", null, "cma_api_error", NOW, null);
      expect(await row(client, id)).toMatchObject({
        tracking_fallback_used: true,
        tracking_fallback_reason: "cma_api_error",
      });
    });
  });

  it("saves the shipment's status, events and ETA", async () => {
    process.env.PARCELSAPP_API_KEY = "key";
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM container_tracking_checks");
      const id = await container(client, "2026-10-28");
      track.mockResolvedValue({
        success: true,
        shipment: {
          trackingId: "MSKU1234567",
          done: true,
          eta: "2026-11-06",
          attributes: [{ l: "status", val: "In transit" }],
          states: [
            {
              date: "2026-10-15T08:00:00Z",
              status: "Vessel departure",
              location: "Durban",
              description: "Left Durban",
            },
            { date: "2026-10-10T08:00:00Z", status: "Gate in", location: "Durban" },
          ],
        },
        rawResponse: { ok: true },
      });
      const outcome = await trackViaParcelsAppApi(id, "MSKU1234567", "MAERSK", null, NOW, "2026-10-28", "Zambia");
      expect(track).toHaveBeenCalledWith("MSKU1234567", "Zambia", "MAERSK");
      expect(outcome).toEqual({
        success: true,
        lastStatus: "In transit",
        lastLocation: "Durban",
        lastDescription: "Left Durban",
        lastCheckedAt: NOW,
        error: null,
      });
      expect(await row(client, id)).toMatchObject({
        eta: "2026-11-06",
        eta_source: "api",
        tracking_last_status: "In transit",
        tracking_provider: "parcelsapp",
        tracking_error: null,
        tracking_fallback_used: false,
        tracking_last_event_date: new Date("2026-10-15T08:00:00Z"),
      });
      expect(await checks(client, id)).toEqual([{ provider: "parcelsapp", status: "success", error_message: null }]);
      expect(
        (await client.query("SELECT count(*)::int AS n FROM container_tracking_events WHERE container_id=$1", [id]))
          .rows[0].n
      ).toBe(2);
      expect(progress(id)).toEqual([["success", "In transit"]]);
    });
  });

  it("keeps the stored ETA when the shipment has none and lets ParcelsApp detect an unknown carrier", async () => {
    process.env.PARCELSAPP_API_KEY = "key";
    await withRolledBackPool(async (client) => {
      const id = await container(client, "2026-10-28");
      track.mockResolvedValue({
        success: true,
        shipment: { trackingId: "MSKU1234567", done: true },
        rawResponse: null,
      });
      const outcome = await trackViaParcelsAppApi(id, "MSKU1234567", "OTHER", "x", NOW, "2026-10-28");
      expect(track).toHaveBeenCalledWith("MSKU1234567", "United States", undefined);
      expect(outcome).toMatchObject({ success: true, lastStatus: null, lastDescription: null });
      expect(await row(client, id)).toMatchObject({ eta: "2026-10-28", eta_source: "manual" });
      expect(progress(id)).toEqual([["success", "got data"]]);

      const blank = await container(client, "2026-10-30");
      await trackViaParcelsAppApi(blank, "MSKU1234567", null, null, NOW, null);
      expect(await row(client, blank)).toMatchObject({ eta: "2026-10-30", eta_source: "manual" });
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("NO UPDATE — no explicit ETA field found"));
    });
  });

  it("records failed and timed-out lookups", async () => {
    process.env.PARCELSAPP_API_KEY = "key";
    await withRolledBackPool(async (client) => {
      const id = await container(client);
      track.mockResolvedValueOnce({
        success: false,
        shipment: null,
        rawResponse: null,
        error: "Tracking request timed out after polling",
        timedOut: true,
      });
      let outcome = await trackViaParcelsAppApi(id, "MSKU1234567", "MAERSK", "r", NOW, null);
      expect(outcome).toMatchObject({ success: false, error: "Tracking request timed out after polling" });
      expect((await checks(client, id)).at(-1)).toMatchObject({ provider: "parcelsapp", status: "timeout" });
      expect(await row(client, id)).toMatchObject({ tracking_provider: "parcelsapp", tracking_error: outcome.error });

      track.mockResolvedValueOnce({ success: true, shipment: null, rawResponse: null });
      outcome = await trackViaParcelsAppApi(id, "MSKU1234567", null, null, NOW, null);
      expect(outcome.error).toBe("Tracking failed");
      expect((await checks(client, id)).at(-1)).toMatchObject({ status: "success" });

      track.mockResolvedValueOnce({ success: false, shipment: null, rawResponse: null, error: "BUSY" });
      await trackViaParcelsAppApi(id, "MSKU1234567", null, null, NOW, null);
      expect((await checks(client, id)).at(-1)).toMatchObject({ status: "error", error_message: "BUSY" });
      expect(progress(id).at(-1)).toEqual(["fail", "BUSY"]);
    });
  });
});
