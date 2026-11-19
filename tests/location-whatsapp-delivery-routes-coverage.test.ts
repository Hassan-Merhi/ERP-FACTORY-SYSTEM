/**
 * Location WhatsApp stock-report delivery history and manual retry
 * (server/routes/location/locationWhatsappDeliveryRoutes.ts) over HTTP with the
 * real database. The report renderer and WhatsApp send
 * (deliverLocationStockWhatsApp) is mocked at the service boundary; stale-run
 * recovery stays real. Covers permission refusals, retry eligibility
 * (not failed, already retrying, already retried), cost-field access, and
 * every provider outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const delivery = vi.hoisted(() => ({ deliver: vi.fn() }));
vi.mock("../server/services/locationStockWhatsAppDelivery", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/locationStockWhatsAppDelivery")>();
  return { ...actual, deliverLocationStockWhatsApp: delivery.deliver };
});

import request from "supertest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { otherCompanyLocation, signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "lwdeliv";
let ctx: TestContext;
let admin: Agent;
let otherLocationId: number;
let seq = 0;
const historyUrl = (id: number | string) => `/api/locations/${id}/whatsapp-deliveries`;
const retryUrl = (loc: number | string, id: number | string) => `/api/locations/${loc}/whatsapp-deliveries/${id}/retry`;

async function addDelivery(fields: Record<string, unknown> = {}): Promise<number> {
  seq += 1;
  const row = {
    company_id: ctx.companyId,
    location_id: ctx.locationId,
    source: "manual",
    status: "failed",
    idempotency_key: `${PREFIX}-${Date.now()}-${seq}`,
    ...fields,
  };
  const keys = Object.keys(row);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO location_whatsapp_stock_deliveries(${keys.join(",")})
     VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`,
    Object.values(row)
  );
  return Number(rows[0].id);
}

function result(status: string, extra: Record<string, unknown> = {}) {
  return {
    deliveryId: 999,
    status,
    duplicate: false,
    itemCount: 3,
    pageCount: 1,
    fileName: "stock.pdf",
    error: null,
    destinationGroupName: "Depot group",
    ...extra,
  };
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  otherLocationId = (await otherCompanyLocation(PREFIX)).locationId;
}, 60000);

afterAll(async () => {
  await pool.query("UPDATE location_whatsapp_stock_deliveries SET retry_of_id=NULL WHERE company_id=$1", [
    ctx.companyId,
  ]);
  await pool.query("DELETE FROM location_whatsapp_stock_deliveries WHERE company_id=$1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

beforeEach(() => {
  delivery.deliver.mockReset().mockResolvedValue(result("sent"));
});

describe("delivery history", () => {
  it("refuses anonymous callers, missing permission and other-company locations", async () => {
    expect((await request(ctx.app).get(historyUrl(ctx.locationId))).status).toBe(401);
    const manager = await signInRole(ctx, PREFIX, "Manager", ["exp_whatsapp_send"]);
    expect((await manager.get(historyUrl(ctx.locationId))).status).toBe(403);
    expect((await admin.get(historyUrl("abc"))).status).toBe(400);
    const foreign = await admin.get(historyUrl(otherLocationId));
    expect(foreign.status).toBe(404);
    expect(foreign.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");
  });

  it("returns an empty summary for a location without deliveries", async () => {
    const res = await admin.get(historyUrl(ctx.location2Id));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      locationId: ctx.location2Id,
      deliveries: [],
      summary: {
        latestStatus: null,
        latestError: null,
        latestAt: null,
        lastSentAt: null,
        lastSentSource: null,
        lastSentIncludeCost: null,
      },
    });
  });

  it("lists attempts, recovers stale runs and hides retry for retried attempts", async () => {
    const stale = await addDelivery({
      location_id: ctx.location2Id,
      status: "running",
      started_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    const parent = await addDelivery({
      location_id: ctx.location2Id,
      status: "failed",
      error: "provider down",
      stock_group_unassigned: true,
      scheduled_for: "2026-03-01",
      report_generated_at: new Date().toISOString(),
    });
    await addDelivery({
      location_id: ctx.location2Id,
      source: "retry",
      status: "sent",
      retry_of_id: parent,
      include_cost: true,
      stock_group_id: ctx.stockGroupId,
      completed_at: new Date().toISOString(),
      initiated_by_user_id: ctx.userId,
    });
    const res = await admin.get(historyUrl(ctx.location2Id)).query({ limit: "500" });
    expect(res.status).toBe(200);
    const byId = new Map(res.body.deliveries.map((d: { id: number }) => [d.id, d]));
    expect(byId.get(stale)).toMatchObject({ status: "failed", canRetry: true });
    expect(byId.get(parent)).toMatchObject({
      canRetry: false,
      stockGroupName: "Unassigned",
      scheduledFor: "2026-03-01",
    });
    expect(res.body.summary).toMatchObject({ lastSentSource: "retry", lastSentIncludeCost: true });
    const limited = await admin.get(historyUrl(ctx.location2Id)).query({ limit: "x" });
    expect(limited.body.deliveries).toHaveLength(3);
    const one = await admin.get(historyUrl(ctx.location2Id)).query({ limit: "0" });
    expect(one.body.deliveries).toHaveLength(1);
  });
});

describe("retry eligibility", () => {
  it("refuses a missing, foreign or not-failed attempt without sending", async () => {
    expect((await admin.post(retryUrl(ctx.locationId, "x")).send({})).status).toBe(400);
    expect((await admin.post(retryUrl(ctx.locationId, 2_147_000_321)).send({})).status).toBe(404);
    const sent = await addDelivery({ status: "sent" });
    const res = await admin.post(retryUrl(ctx.locationId, sent)).send({});
    expect(res.status).toBe(409);
    expect(res.body.message).toBe("Only failed or empty delivery attempts can be retried");
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("refuses an attempt that is already being retried or was retried", async () => {
    const running = await addDelivery();
    await addDelivery({ source: "retry", status: "running", retry_of_id: running });
    const a = await admin.post(retryUrl(ctx.locationId, running)).send({});
    expect([a.status, a.body.message]).toEqual([409, "A retry for this delivery is already in progress"]);
    const done = await addDelivery({ status: "skipped_empty" });
    await addDelivery({ source: "retry", status: "sent", retry_of_id: done });
    const b = await admin.post(retryUrl(ctx.locationId, done)).send({});
    expect([b.status, b.body.message]).toEqual([409, "This delivery has already been successfully retried"]);
    expect(delivery.deliver).not.toHaveBeenCalled();
  });

  it("requires cost and total-value access to retry a report with cost", async () => {
    const withCost = await addDelivery({ include_cost: true });
    const owner = await signInRole(ctx, PREFIX, "Owner", ["fld_cost_price"]);
    expect((await owner.post(retryUrl(ctx.locationId, withCost)).send({})).body.key).toBe("fld_cost_price");
    const tester = await signInRole(ctx, PREFIX, "ERP Tester", ["fld_total_value"]);
    expect((await tester.post(retryUrl(ctx.locationId, withCost)).send({})).body.key).toBe("fld_total_value");
    expect(delivery.deliver).not.toHaveBeenCalled();
    const ok = await admin.post(retryUrl(ctx.locationId, withCost)).send({});
    expect(ok.status).toBe(200);
  });
});

describe("retry outcomes", () => {
  it("replays the original filters with the supplied idempotency key and audits success", async () => {
    const id = await addDelivery({
      stock_group_id: ctx.stockGroupId,
      scheduled_for: "2026-03-02",
      include_zero_stock: true,
    });
    const res = await admin.post(retryUrl(ctx.locationId, id)).send({ idempotencyKey: "key-1" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: "Stock report retry sent successfully", status: "sent" });
    expect(delivery.deliver).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: ctx.companyId,
        locationId: ctx.locationId,
        stockGroupId: ctx.stockGroupId,
        includeZeroStock: true,
        source: "retry",
        retryOfId: id,
        // The retry replays the original DATE as YYYY-MM-DD.
        scheduledFor: "2026-03-02",
        idempotencyKey: `retry:${ctx.companyId}:${ctx.locationId}:${id}:key-1`,
      })
    );
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND action='retry_location_stock_whatsapp'",
      [ctx.companyId]
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it("maps unassigned and unfiltered groups and ignores an unsafe idempotency key", async () => {
    const unassigned = await addDelivery({ stock_group_unassigned: true });
    await admin.post(retryUrl(ctx.locationId, unassigned)).send({ idempotencyKey: "bad key!" });
    const first = delivery.deliver.mock.calls[0][0];
    expect(first.stockGroupId).toBeNull();
    expect(first.scheduledFor).toBeNull();
    expect(first.idempotencyKey).toMatch(
      new RegExp(`^retry:${ctx.companyId}:${ctx.locationId}:${unassigned}:[0-9a-f-]{36}$`)
    );
    const all = await addDelivery();
    await admin.post(retryUrl(ctx.locationId, all)).send({});
    expect(delivery.deliver.mock.calls[1][0].stockGroupId).toBeUndefined();
  });

  it("reports running, empty and failed outcomes", async () => {
    const outcomes: Array<[ReturnType<typeof result>, number, string]> = [
      [result("running"), 202, "This retry is already in progress"],
      [result("skipped_empty"), 400, "The retry found no stock matching the original report filters"],
      [result("failed", { error: "Group not found" }), 502, "Group not found"],
      [result("failed"), 502, "WhatsApp retry failed"],
    ];
    for (const [outcome, status, message] of outcomes) {
      delivery.deliver.mockResolvedValueOnce(outcome);
      const id = await addDelivery();
      const res = await admin.post(retryUrl(ctx.locationId, id)).send({});
      expect([res.status, res.body.message]).toEqual([status, message]);
    }
  });

  it("turns a duplicate-retry race into 409 and other failures into 500", async () => {
    delivery.deliver.mockRejectedValueOnce(Object.assign(new Error("duplicate key"), { code: "23505" }));
    const raced = await addDelivery();
    const a = await admin.post(retryUrl(ctx.locationId, raced)).send({});
    expect(a.status).toBe(409);
    delivery.deliver.mockRejectedValueOnce(new Error("renderer crashed"));
    const broken = await addDelivery();
    const b = await admin.post(retryUrl(ctx.locationId, broken)).send({});
    expect([b.status, b.body.message]).toEqual([500, "renderer crashed"]);
  });
});
