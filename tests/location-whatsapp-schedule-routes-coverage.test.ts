/**
 * Location automatic WhatsApp stock-report schedule routes
 * (server/routes/location/locationWhatsappScheduleRoutes.ts) over HTTP with the
 * real database: permission and company refusals, every validation refusal,
 * the destination checks for enabling a schedule, and the next-send
 * computation. No message is sent by these routes.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { otherCompanyLocation, signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";
import request from "supertest";

const PREFIX = "lwsched";
let ctx: TestContext;
let admin: Agent;
let otherLocationId: number;
let categoryId: number;
const url = (id: number | string) => `/api/locations/${id}/whatsapp-schedule`;

const valid = {
  enabled: false,
  frequency: "daily",
  sendTime: "18:00",
  timezone: "Africa/Lubumbashi",
};

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  otherLocationId = (await otherCompanyLocation(PREFIX)).locationId;
  const category = await pool.query<{ id: number }>(
    "INSERT INTO stock_categories(company_id,name) VALUES($1,$2) RETURNING id",
    [ctx.companyId, `${PREFIX}_Category`]
  );
  categoryId = category.rows[0].id;
}, 60000);

afterAll(async () => {
  await pool.query("DELETE FROM location_whatsapp_stock_schedules WHERE company_id=$1", [ctx.companyId]);
  await pool.query("DELETE FROM location_whatsapp_stock_reports WHERE company_id=$1", [ctx.companyId]);
  await pool.query("DELETE FROM stock_categories WHERE company_id=$1", [ctx.companyId]);
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

async function scheduleRow(locationId: number) {
  const { rows } = await pool.query("SELECT * FROM location_whatsapp_stock_schedules WHERE location_id=$1", [
    locationId,
  ]);
  return rows[0];
}

describe("access", () => {
  it("refuses anonymous callers and roles without the WhatsApp export permission", async () => {
    expect((await request(ctx.app).get(url(ctx.locationId))).status).toBe(401);
    const manager = await signInRole(ctx, PREFIX, "Manager", ["exp_whatsapp_send"]);
    expect((await manager.get(url(ctx.locationId))).status).toBe(403);
    expect((await manager.put(url(ctx.locationId)).send(valid)).status).toBe(403);
    expect(await scheduleRow(ctx.locationId)).toBeUndefined();
  });

  it("refuses to save a cost schedule without cost and total-value access", async () => {
    const owner = await signInRole(ctx, PREFIX, "Owner", ["fld_cost_price"]);
    const noCost = await owner.put(url(ctx.locationId)).send({ ...valid, includeCost: "true" });
    expect(noCost.status).toBe(403);
    expect(noCost.body.key).toBe("fld_cost_price");
    const tester = await signInRole(ctx, PREFIX, "ERP Tester", ["fld_total_value"]);
    const noTotal = await tester.put(url(ctx.locationId)).send({ ...valid, includeCost: 1 });
    expect(noTotal.status).toBe(403);
    expect(noTotal.body.key).toBe("fld_total_value");
    expect(await scheduleRow(ctx.locationId)).toBeUndefined();
  });

  it("refuses a bad, missing or other-company location", async () => {
    for (const method of ["get", "put"] as const) {
      expect((await admin[method](url("abc")).send(valid)).status).toBe(400);
      expect((await admin[method](url(2_147_000_123)).send(valid)).status).toBe(404);
      const foreign = await admin[method](url(otherLocationId)).send(valid);
      // The company resource boundary refuses another company's location before the route runs.
      expect(foreign.status).toBe(404);
      expect(foreign.body.code).toBe("CROSS_COMPANY_ACCESS_DENIED");
    }
  });
});

describe("GET schedule", () => {
  it("returns the disabled default when nothing is saved", async () => {
    const res = await admin.get(url(ctx.location2Id));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      locationId: ctx.location2Id,
      enabled: false,
      frequency: "daily",
      sendTime: "18:00",
      includeNegativeStock: true,
      nextSendAt: null,
    });
  });
});

describe("PUT schedule validation", () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ["frequency", { frequency: "weekly" }, "Frequency must be daily or selected_days"],
    ["no days", { frequency: "selected_days", daysOfWeek: [] }, "Select at least one day for this schedule"],
    ["days not a list", { frequency: "selected_days", daysOfWeek: "1" }, "Select at least one day for this schedule"],
    [
      "out-of-range days",
      { frequency: "selected_days", daysOfWeek: [7, -1] },
      "Select at least one day for this schedule",
    ],
    ["hour", { sendTime: "24:00" }, "Invalid send time. Use HH:mm"],
    ["minute", { sendTime: "10:60" }, "Invalid send time. Use HH:mm"],
    ["format", { sendTime: "7:5" }, "Invalid send time. Use HH:mm"],
    ["type", { sendTime: 1800 }, "Invalid send time. Use HH:mm"],
    ["timezone", { timezone: "Mars/Olympus" }, "Invalid IANA timezone"],
    ["blank timezone", { timezone: "  " }, "Invalid IANA timezone"],
    ["group id", { stockGroupId: "abc" }, "Invalid group ID"],
    ["foreign group", { stockGroupId: 2_147_000_124 }, "Stock group not found for this company"],
    ["category id", { categoryId: -4 }, "Invalid category ID"],
    ["foreign category", { categoryId: 2_147_000_125 }, "Stock category not found for this company"],
  ];
  for (const [name, patch, message] of cases) {
    it(`refuses an invalid ${name}`, async () => {
      const res = await admin.put(url(ctx.locationId)).send({ ...valid, ...patch });
      expect(res.status).toBe(400);
      expect(res.body.message).toBe(message);
    });
  }

  it("refuses to enable without a linked, enabled WhatsApp group", async () => {
    const res = await admin.put(url(ctx.locationId)).send({ ...valid, enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toContain("Link and enable the location WhatsApp group");
    await pool.query(
      `INSERT INTO location_whatsapp_stock_reports(location_id,company_id,whatsapp_group_chat_id,enabled)
       VALUES($1,$2,'243810000001@c.us',true)`,
      [ctx.locationId, ctx.companyId]
    );
    const notGroup = await admin.put(url(ctx.locationId)).send({ ...valid, enabled: "1" });
    expect(notGroup.status).toBe(400);
    expect(notGroup.body.message).toBe("The linked WhatsApp destination is not a valid group");
    expect(await scheduleRow(ctx.locationId)).toBeUndefined();
  });
});

describe("PUT schedule saves", () => {
  it("saves a disabled daily schedule with filters and audits it", async () => {
    const res = await admin.put(url(ctx.locationId)).send({
      ...valid,
      sendTime: " 7:05 ",
      stockGroupId: String(ctx.stockGroupId),
      categoryId: categoryId,
      includeZeroStock: true,
      includeNegativeStock: "false",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: false,
      sendTime: "07:05",
      stockGroupId: ctx.stockGroupId,
      categoryId,
      includeZeroStock: true,
      includeNegativeStock: false,
      nextSendAt: null,
    });
    const audit = await pool.query(
      "SELECT count(*)::int AS n FROM audit_log WHERE company_id=$1 AND action='update_location_whatsapp_stock_schedule'",
      [ctx.companyId]
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it("enables selected days for a linked group and computes the next send", async () => {
    await pool.query(
      "UPDATE location_whatsapp_stock_reports SET whatsapp_group_chat_id='120363000000000001@g.us' WHERE location_id=$1",
      [ctx.locationId]
    );
    const res = await admin.put(url(ctx.locationId)).send({
      ...valid,
      enabled: true,
      frequency: "selected_days",
      daysOfWeek: [3, "1", 3],
      stockGroupId: "all",
      categoryId: "",
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      enabled: true,
      frequency: "selected_days",
      daysOfWeek: [1, 3],
      stockGroupId: null,
    });
    expect(typeof res.body.nextSendAt).toBe("string");
    const row = await scheduleRow(ctx.locationId);
    expect(row.days_of_week).toEqual([1, 3]);
  });

  it("computes next sends from the saved schedule state", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lubumbashi" }).format(new Date());
    const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
    const otherDay = (weekday + 3) % 7;

    // Due now: the send time has passed and nothing was sent today.
    await pool.query(
      "UPDATE location_whatsapp_stock_schedules SET frequency='daily',send_time='00:00',last_scheduled_for=NULL WHERE location_id=$1",
      [ctx.locationId]
    );
    const due = await admin.get(url(ctx.locationId));
    expect(Math.abs(Date.parse(due.body.nextSendAt) - Date.now())).toBeLessThan(60_000);

    // Already sent today: the next run is tomorrow at the send time.
    await pool.query(
      "UPDATE location_whatsapp_stock_schedules SET last_scheduled_for=$2::date, last_status='sent', last_sent_at=now(), last_attempt_at=now() WHERE location_id=$1",
      [ctx.locationId, today]
    );
    const tomorrow = await admin.get(url(ctx.locationId));
    expect(Date.parse(tomorrow.body.nextSendAt)).toBeGreaterThan(Date.now());
    expect(tomorrow.body).toMatchObject({ lastScheduledFor: today, lastStatus: "sent" });
    expect(tomorrow.body.lastSentAt).toEqual(expect.any(String));

    // Only another weekday allowed: the next run is that day.
    await pool.query(
      "UPDATE location_whatsapp_stock_schedules SET frequency='selected_days',days_of_week=$2::int[],send_time='12:00' WHERE location_id=$1",
      [ctx.locationId, [otherDay]]
    );
    const later = await admin.get(url(ctx.locationId));
    expect(new Date(later.body.nextSendAt).getUTCDay()).toBe(otherDay);

    // An empty selected-day list never sends; an unknown stored timezone never sends.
    await pool.query("UPDATE location_whatsapp_stock_schedules SET days_of_week='{}' WHERE location_id=$1", [
      ctx.locationId,
    ]);
    expect((await admin.get(url(ctx.locationId))).body.nextSendAt).toBeNull();
    await pool.query("UPDATE location_whatsapp_stock_schedules SET timezone='Mars/Olympus' WHERE location_id=$1", [
      ctx.locationId,
    ]);
    expect((await admin.get(url(ctx.locationId))).body.nextSendAt).toBeNull();
  });
});
