/**
 * Scheduled WhatsApp message routes
 * (server/routes/scheduledWhatsAppMessageRoutes.ts) over HTTP, one rolled-back
 * company per test. Refusals first: non-manager roles, every body validation,
 * inactive / non-group / other-company recipients, unknown and other-company
 * schedules, invalid ids - none of which write. Then create, list, update
 * (recipients replaced), delivery history and delete.
 */
import { describe, expect, it } from "vitest";

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const BASE = "/api/whatsapp/message-schedules";

async function group(w: FactoryWorld, opts: { active?: boolean; isGroup?: boolean; companyId?: number } = {}) {
  return w.one(
    `INSERT INTO whatsapp_recipients (company_id, chat_id, name, is_group, active) VALUES ($1, $2, 'Sales Group', $3, $4)
     RETURNING id`,
    [
      opts.companyId ?? w.companyId,
      `1203630${Math.floor(Math.random() * 1e9)}@g.us`,
      opts.isGroup ?? true,
      opts.active ?? true,
    ]
  );
}

const body = (recipientIds: unknown, extra: Record<string, unknown> = {}) => ({
  title: "Morning stock",
  message: "Remember to count the yard.",
  timezone: "Africa/Lubumbashi",
  weeklyTimes: { 1: "08:30", 3: "", 5: "17:00" },
  startDate: "2026-01-01",
  endDate: "2026-12-31",
  recipientIds,
  enabled: true,
  ...extra,
});

const schedules = (w: FactoryWorld) =>
  w.q(`SELECT id, title FROM whatsapp_message_schedules WHERE company_id = $1`, [w.companyId]);

describe("refusals", () => {
  it("refuses roles other than Admin, Owner and Developer on every route", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      const calls = [
        () => manager.get(BASE),
        () => manager.get(`${BASE}/history`),
        () => manager.post(BASE).send({}),
        () => manager.put(`${BASE}/1`).send({}),
        () => manager.delete(`${BASE}/1`),
      ];
      for (const call of calls) {
        const res = await call();
        expect(res.status).toBe(403);
        expect(res.body.message).toMatch(/Only Admin, Owner or Developer/);
      }
    }));

  it("validates the schedule body", () =>
    withFactoryWorld(async (w) => {
      const id = await group(w);
      const cases: Array<[unknown, RegExp]> = [
        [null, /Title is required/],
        [body([id], { title: "x".repeat(121) }), /Title is required/],
        [body([id], { message: "  " }), /Message must be/],
        [body([id], { timezone: "" }), /Invalid timezone/],
        [body([id], { timezone: "Mars/Olympus" }), /valid timezone/],
        [body([id], { weeklyTimes: [] }), /at least one day/],
        [body([id], { weeklyTimes: { 1: "25:00" } }), /valid 24-hour/],
        [body([id], { weeklyTimes: { 1: null } }), /Enable at least one weekday/],
        [body([id], { startDate: "2026-13-45" }), /Invalid start or end date/],
        [body([id], { startDate: "2026-06-01", endDate: "2026-05-01" }), /Invalid start or end date/],
        [body([id], { endDate: 20260101 }), /Invalid start or end date/],
        [body([]), /between 1 and 50/],
        [body("1"), /between 1 and 50/],
        [body([0]), /between 1 and 50/],
        [body([id], { enabled: "yes" }), /Enabled must be true or false/],
      ];
      for (const [payload, message] of cases) {
        const res = await w.agent.post(BASE).send(payload as object);
        expect(res.status, JSON.stringify(payload)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await schedules(w)).toEqual([]);
    }));

  it("refuses inactive, non-group and other-company recipients", () =>
    withFactoryWorld(async (w) => {
      const good = await group(w);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      for (const bad of [
        await group(w, { active: false }),
        await group(w, { isGroup: false }),
        await group(w, { companyId: other }),
      ]) {
        const res = await w.agent.post(BASE).send(body([good, bad]));
        expect(res.status).toBe(400);
        expect(res.body.message).toBe("One or more selected groups are not active in this company");
      }
      expect(await schedules(w)).toEqual([]);
    }));

  it("refuses invalid ids and unknown or other-company schedules", () =>
    withFactoryWorld(async (w) => {
      const id = await group(w);
      expect((await w.agent.put(`${BASE}/abc`).send(body([id]))).status).toBe(400);
      expect((await w.agent.delete(`${BASE}/-1`)).status).toBe(400);
      const other = await w.one(`INSERT INTO companies (code, name) VALUES ($1::varchar, $1::text) RETURNING id`, [
        `${w.tag}O`,
      ]);
      const foreign = await w.one(
        `INSERT INTO whatsapp_message_schedules (company_id, title, message, timezone, weekly_times, enabled)
         VALUES ($1, 'Foreign', 'Hi', 'UTC', '{"1":"09:00"}'::jsonb, true) RETURNING id`,
        [other]
      );
      const update = await w.agent.put(`${BASE}/${foreign}`).send(body([id]));
      expect(update.status).toBe(404);
      expect(update.body.message).toBe("Schedule not found for this company");
      expect((await w.agent.delete(`${BASE}/${foreign}`)).status).toBe(404);
      const [still] = await w.q(`SELECT title FROM whatsapp_message_schedules WHERE id = $1`, [foreign]);
      expect(still.title).toBe("Foreign");
    }));
});

describe("schedule lifecycle", () => {
  it("creates, lists, updates, reports history and deletes a schedule", () =>
    withFactoryWorld(async (w) => {
      const first = await group(w);
      const second = await group(w);
      const created = await w.agent.post(BASE).send(body([first, String(first), second], { endDate: "" }));
      expect(created.status).toBe(200);
      expect(created.body.message).toBe("Schedule created");
      const id = created.body.id;

      const list = await w.agent.get(BASE);
      expect(list.status).toBe(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          id,
          title: "Morning stock",
          timezone: "Africa/Lubumbashi",
          weeklyTimes: { 1: "08:30", 5: "17:00" },
          startDate: "2026-01-01",
          endDate: null,
          enabled: true,
        }),
      ]);
      expect([...list.body[0].recipientIds].sort()).toEqual([first, second].sort());

      const updated = await w.agent
        .put(`${BASE}/${id}`)
        .send(body([second], { title: "Evening stock", enabled: false, startDate: null }));
      expect(updated.body).toEqual({ id, message: "Schedule updated" });
      const recipients = await w.q(
        `SELECT recipient_id FROM whatsapp_message_schedule_recipients WHERE schedule_id = $1`,
        [id]
      );
      expect(recipients.map((r) => r.recipient_id)).toEqual([second]);

      await w.q(
        `INSERT INTO whatsapp_message_schedule_deliveries (schedule_id, recipient_id, recipient_name, local_date,
           message_snapshot, status, error)
         VALUES ($1, $2, 'Sales Group', '2026-03-02', 'Hi', 'failed', 'GREEN API timeout')`,
        [id, second]
      );
      const history = await w.agent.get(`${BASE}/history`);
      expect(history.body).toEqual([
        expect.objectContaining({
          title: "Evening stock",
          recipientName: "Sales Group",
          localDate: "2026-03-02",
          status: "failed",
          error: "GREEN API timeout",
          sentAt: null,
        }),
      ]);

      const removed = await w.agent.delete(`${BASE}/${id}`);
      expect(removed.body).toEqual({ message: "Schedule removed" });
      expect(await schedules(w)).toEqual([]);
    }));
});
