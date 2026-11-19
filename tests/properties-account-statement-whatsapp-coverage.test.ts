/**
 * Properties account WhatsApp statement routes through the real app in a
 * rolled-back world. The WhatsApp provider (whatsappService) and the statement
 * sender are mocked at their module boundaries. Covers role and company-type
 * refusals, every schedule validation, provider-verified group selection,
 * manual-send refusals (duplicate, provider rejection) and history.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  settings: null as null | { enabled: boolean; instanceId: string; apiToken: string },
  chats: [] as Array<{ id: string }>,
  sendResult: { accepted: true, duplicate: false } as Record<string, unknown>,
  sends: [] as Array<Record<string, unknown>>,
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getPosWaSettings: async () => wa.settings,
  fetchGreenApiChats: async () => wa.chats,
}));
vi.mock("../server/services/propertiesAccountStatementWhatsApp", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/propertiesAccountStatementWhatsApp")>()),
  sendPropertiesWaStatement: async (input: Record<string, unknown>) => {
    wa.sends.push(input);
    return wa.sendResult;
  },
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const GROUP = "120363000000000123@g.us";
const valid = {
  enabled: true,
  chatId: "+243 810 000 123",
  frequency: "weekly",
  sendTime: "08:30",
  dayOfWeek: 1,
  dayOfMonth: 1,
  timezone: "Africa/Kinshasa",
  periodMode: "current_month",
};

async function propertiesAccount(w: FactoryWorld) {
  await w.q(`UPDATE companies SET company_type = 'properties' WHERE id = $1`, [w.companyId]);
  return w.one(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'Tenant A', 'Asset') RETURNING id`,
    [w.companyId, `${w.tag}T`]
  );
}

const base = (id: number | string) => `/api/properties/accounts/${id}/whatsapp-statement`;
const schedule = async (w: FactoryWorld, accountId: number) =>
  w.q(`SELECT chat_id, enabled, frequency FROM properties_account_wa_schedules WHERE account_id = $1`, [accountId]);

beforeEach(() => {
  wa.settings = null;
  wa.chats = [];
  wa.sendResult = { accepted: true, duplicate: false };
  wa.sends = [];
});

describe("properties WhatsApp statement routes", () => {
  it("refuses other roles, bad ids, non-properties companies and foreign accounts", () =>
    withFactoryWorld(async (w) => {
      const factoryAccount = await w.one(
        `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, 'X', 'Asset') RETURNING id`,
        [w.companyId, `${w.tag}F`]
      );
      expect((await w.agent.get(base(factoryAccount))).status).toBe(404);
      const accountId = await propertiesAccount(w);
      const manager = await w.agentFor("Manager");
      expect((await manager.get(base(accountId))).status).toBe(403);
      expect((await w.agent.get(base("abc"))).status).toBe(400);
      expect((await w.agent.get(base(2_000_000_000))).status).toBe(404);
      expect((await w.agent.get(`${base(2_000_000_000)}/history`)).status).toBe(404);
      expect((await w.agent.post(`${base(2_000_000_000)}/send`).send({})).status).toBe(404);
      expect((await w.agent.put(base(2_000_000_000)).send(valid)).status).toBe(404);
    }));

  it("returns defaults, validates every schedule field, and saves a contact", () =>
    withFactoryWorld(async (w) => {
      const accountId = await propertiesAccount(w);
      const defaults = await w.agent.get(base(accountId));
      expect(defaults.status).toBe(200);
      expect(defaults.body).toHaveProperty("frequency");

      const refusals: Array<[Record<string, unknown>, RegExp]> = [
        [{ enabled: "yes" }, /true or false/],
        [{ chatId: "" }, /before enabling/],
        [{ chatId: "hello" }, /international phone number/],
        [{ frequency: "hourly" }, /daily, weekly or monthly/],
        [{ sendTime: "25:00" }, /24-hour/],
        [{ dayOfWeek: 7 }, /schedule day/],
        [{ dayOfMonth: 29 }, /schedule day/],
        [{ timezone: "x".repeat(81) }, /Invalid timezone/],
        [{ timezone: "Mars/Olympus" }, /Invalid timezone/],
        [{ periodMode: "last_year" }, /statement period/],
      ];
      for (const [patch, message] of refusals) {
        const res = await w.agent.put(base(accountId)).send({ ...valid, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
        expect(res.body.message).toMatch(message);
      }
      expect(await schedule(w, accountId)).toEqual([]);

      expect((await w.agent.put(base(accountId)).send(valid)).body).toEqual({ success: true });
      expect(await schedule(w, accountId)).toEqual([
        { chat_id: "243810000123@c.us", enabled: true, frequency: "weekly" },
      ]);
      const saved = await w.agent.get(base(accountId));
      expect(saved.body).toMatchObject({ chatId: "243810000123@c.us", sendTime: "08:30", periodMode: "current_month" });

      const disabled = await w.agent.put(base(accountId)).send({ ...valid, enabled: false, chatId: "" });
      expect(disabled.status).toBe(200);
      expect((await schedule(w, accountId))[0]).toMatchObject({ chat_id: "", enabled: false });
    }));

  it("accepts a group only when the connected instance can see it", () =>
    withFactoryWorld(async (w) => {
      const accountId = await propertiesAccount(w);
      const group = { ...valid, chatId: GROUP, frequency: "monthly", timezone: undefined };
      expect((await w.agent.put(base(accountId)).send(group)).status).toBe(503);
      wa.settings = { enabled: true, instanceId: "1101", apiToken: "tok" };
      wa.chats = [{ id: "120363999999999999@g.us" }];
      const hidden = await w.agent.put(base(accountId)).send(group);
      expect(hidden.status).toBe(400);
      expect(hidden.body.message).toMatch(/not accessible/);
      expect(await schedule(w, accountId)).toEqual([]);
      wa.chats = [{ id: GROUP }];
      expect((await w.agent.put(base(accountId)).send(group)).status).toBe(200);
      expect(await schedule(w, accountId)).toEqual([{ chat_id: GROUP, enabled: true, frequency: "monthly" }]);
    }));

  it("refuses manual sends without a recipient, with bad ranges or keys, and maps send outcomes", () =>
    withFactoryWorld(async (w) => {
      const accountId = await propertiesAccount(w);
      const send = (body: Record<string, unknown>) => w.agent.post(`${base(accountId)}/send`).send(body);
      const requestId = "manual-request-0001";
      expect((await send({ requestId })).body.message).toMatch(/Save a group or contact/);
      await w.agent.put(base(accountId)).send(valid);
      for (const body of [
        { requestId, startDate: "2026-02-30" },
        { requestId, endDate: "2026/03/01" },
        { requestId, startDate: "2026-03-02", endDate: "2026-03-01" },
      ]) {
        expect((await send(body)).body.message).toBe("Invalid statement date range");
      }
      expect((await send({ requestId: "short" })).status).toBe(400);
      expect(wa.sends).toEqual([]);

      const ok = await send({ requestId, startDate: "2026-03-01", endDate: "2026-03-31" });
      expect(ok.body).toEqual({ success: true, deliveryStatus: "accepted" });
      expect(wa.sends[0]).toMatchObject({
        accountId,
        chatId: "243810000123@c.us",
        attemptKey: `manual:${requestId}`,
        startDate: "2026-03-01",
      });
      wa.sendResult = { accepted: true, duplicate: true };
      expect((await send({ requestId })).status).toBe(409);
      wa.sendResult = { accepted: false, status: "rejected", error: "Provider said no" };
      const rejected = await send({ requestId: "manual-request-0002" });
      expect(rejected.status).toBe(502);
      expect(rejected.body).toEqual({ message: "Provider said no", status: "rejected" });
      wa.sendResult = { accepted: false };
      expect((await send({ requestId: "manual-request-0003" })).body.message).toBe(
        "WhatsApp did not accept this statement"
      );
    }));

  it("lists delivery history for the account", () =>
    withFactoryWorld(async (w) => {
      const accountId = await propertiesAccount(w);
      const res = await w.agent.get(`${base(accountId)}/history`);
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    }));
});
