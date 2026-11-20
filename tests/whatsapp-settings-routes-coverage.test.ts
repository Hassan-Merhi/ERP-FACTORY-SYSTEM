/**
 * General WhatsApp settings and manual Net Position sends
 * (registerWhatsAppRoutesPart1.ts / registerWhatsAppRoutesPart2.ts) through
 * the real HTTP app in one rolled-back transaction per test, so the singleton
 * settings rows never leak. GREEN API, the e-mail transport, the scheduler
 * entry point and the Net Position workbook renderer are mocked at their
 * module boundaries.
 *
 * The settings rows (Green API credentials, POS credentials, stock and Net
 * Position schedules) are Admin/Developer only, for reads too, and the stored
 * API token never leaves the server: GETs return a mask, and a PUT that echoes
 * the mask (or omits the token) keeps the stored one.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  posSettings: vi.fn(),
  state: vi.fn(),
  sendFile: vi.fn(),
  sendToChat: vi.fn(),
  netPosition: vi.fn(),
  email: vi.fn(),
  trigger: vi.fn(),
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getWaSettings: m.settings,
  getPosWaSettings: m.posSettings,
  getStrictGreenMainInstanceState: m.state,
  sendWhatsAppFile: m.sendFile,
  sendWhatsAppFileToChatId: m.sendToChat,
}));
vi.mock("../server/helpers/generateNetPositionExcel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/helpers/generateNetPositionExcel")>()),
  generateNetPositionExcel: m.netPosition,
}));
vi.mock("../server/services/emailService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/emailService")>()),
  sendExportEmail: m.email,
}));
vi.mock("../server/services/scheduler", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/scheduler")>()),
  triggerDailyWhatsAppSendNow: m.trigger,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

beforeEach(() => {
  m.settings.mockReset().mockResolvedValue({ enabled: true, instanceId: "1101", apiToken: "tok" });
  m.posSettings.mockReset().mockResolvedValue({ enabled: true, instanceId: "2202", apiToken: "pos" });
  m.state.mockReset().mockResolvedValue("authorized");
  m.sendFile.mockReset().mockResolvedValue({ success: true, sent: 2, errors: [] });
  m.sendToChat.mockReset().mockResolvedValue({ success: true });
  m.netPosition.mockReset().mockResolvedValue(Buffer.from("xlsx"));
  m.email.mockReset().mockResolvedValue({ success: true });
  m.trigger.mockReset().mockResolvedValue({ message: "done" });
});

const SETTINGS_ROUTES = [
  "/api/whatsapp/settings",
  "/api/whatsapp/settings/pos",
  "/api/whatsapp/stock-settings",
  "/api/whatsapp/np-settings",
];
const MAIN_TOKEN = "main-green-api-token-0001";
const POS_TOKEN = "pos-green-api-token-0002";

async function seedSettings(w: FactoryWorld) {
  await w.q(
    `INSERT INTO whatsapp_settings (id, instance_id, api_token, enabled) VALUES (1, '1101', $1, true), (2, '2202', $2, true)
       ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id, api_token = EXCLUDED.api_token,
                                      enabled = EXCLUDED.enabled`,
    [MAIN_TOKEN, POS_TOKEN]
  );
  await w.q(
    `INSERT INTO whatsapp_stock_settings (id, company_id, enabled, frequency, send_hour) VALUES (1, $1, true, 'daily', 18)
       ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, enabled = true, frequency = 'daily', send_hour = 18`,
    [w.companyId]
  );
  await w.q(
    `INSERT INTO net_position_export_settings (id, enabled, frequency, send_hour) VALUES (1, true, 'daily', 18)
       ON CONFLICT (id) DO UPDATE SET enabled = true, frequency = 'daily', send_hour = 18`
  );
}

const settingsState = async (w: FactoryWorld) => ({
  wa: await w.q(`SELECT id, instance_id, api_token, enabled FROM whatsapp_settings WHERE id IN (1, 2) ORDER BY id`),
  stock: await w.q(`SELECT * FROM whatsapp_stock_settings ORDER BY id`),
  np: await w.q(`SELECT * FROM net_position_export_settings ORDER BY id`),
});

describe("WhatsApp settings access", () => {
  it("refuses Staff, Manager and POS reads and writes of every settings row and changes nothing", async () => {
    await withFactoryWorld(async (w) => {
      await seedSettings(w);
      const before = await settingsState(w);
      const hijack = { instanceId: "9999", apiToken: "attacker", enabled: false, frequency: "weekly", sendHour: 3 };
      for (const role of ["Staff", "Manager", "POS"]) {
        const agent = await w.agentFor(role);
        for (const route of SETTINGS_ROUTES) {
          const read = await agent.get(route);
          expect(read.status, `${role} GET ${route}`).toBe(403);
          expect(JSON.stringify(read.body)).not.toContain("green-api-token");
          expect((await agent.put(route).send(hijack)).status, `${role} PUT ${route}`).toBe(403);
        }
      }
      expect(await settingsState(w)).toEqual(before);
    });
  });

  it("lets Admin and Developer read and write every settings row", async () => {
    await withFactoryWorld(async (w) => {
      await seedSettings(w);
      const developer = await w.agentFor("Developer");
      for (const agent of [w.agent, developer]) {
        for (const route of SETTINGS_ROUTES) {
          const read = await agent.get(route);
          expect(read.status, `GET ${route}`).toBe(200);
          expect(JSON.stringify(read.body)).not.toContain("green-api-token");
        }
      }
      expect((await developer.put("/api/whatsapp/settings/pos").send({ enabled: false })).status).toBe(200);
      expect((await developer.put("/api/whatsapp/stock-settings").send({ sendHour: 7 })).status).toBe(200);
      expect((await w.agent.put("/api/whatsapp/np-settings").send({ frequency: "weekly" })).status).toBe(200);
      const after = await settingsState(w);
      expect(after.wa).toEqual([
        { id: 1, instance_id: "1101", api_token: MAIN_TOKEN, enabled: true },
        { id: 2, instance_id: "2202", api_token: POS_TOKEN, enabled: false },
      ]);
      expect(after.stock[0]).toMatchObject({ send_hour: 7 });
      expect(after.np[0]).toMatchObject({ frequency: "weekly" });
    });
  });
});

describe("WhatsApp main settings", () => {
  it("returns defaults without a row, never returns the token and keeps it on a masked save", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`DELETE FROM whatsapp_settings WHERE id = 1`);
      expect((await w.agent.get("/api/whatsapp/settings")).body).toEqual({
        instanceId: "",
        apiToken: "",
        apiTokenSet: false,
        enabled: false,
        monthlyAutoSend: false,
      });
      m.settings.mockResolvedValueOnce(null);
      const created = await w.agent.put("/api/whatsapp/settings").send({ instanceId: "1101", apiToken: MAIN_TOKEN });
      expect(created.status).toBe(200);
      const read = await w.agent.get("/api/whatsapp/settings");
      expect(read.body).toMatchObject({
        instanceId: "1101",
        apiToken: "••••••0001",
        apiTokenSet: true,
        enabled: false,
        hasCredentials: true,
      });
      expect(JSON.stringify(read.body)).not.toContain(MAIN_TOKEN);

      m.settings.mockResolvedValue({
        instanceId: "1101",
        apiToken: MAIN_TOKEN,
        enabled: true,
        monthlyAutoSend: true,
        dailyAutoSend: false,
        dailyRecipientId: null,
      });
      const token = async () => (await w.q(`SELECT api_token FROM whatsapp_settings WHERE id = 1`))[0].api_token;
      // The mask sent back as-is, the legacy mask, an omitted or blank token never overwrite it.
      await w.agent.put("/api/whatsapp/settings").send({ apiToken: read.body.apiToken, enabled: true });
      expect(await token()).toBe(MAIN_TOKEN);
      for (const body of [{ apiToken: "••••••" }, {}, { apiToken: "" }, { apiToken: null }, { apiToken: 42 }]) {
        expect((await w.agent.put("/api/whatsapp/settings").send(body)).status).toBe(200);
        expect(await token(), JSON.stringify(body)).toBe(MAIN_TOKEN);
      }
      const [row] = await w.q(`SELECT enabled, monthly_auto_send FROM whatsapp_settings WHERE id = 1`);
      expect(row).toEqual({ enabled: true, monthly_auto_send: true });

      await w.agent.put("/api/whatsapp/settings").send({ apiToken: "  short  " });
      expect(await token()).toBe("short");
      // A short token is masked completely.
      expect((await w.agent.get("/api/whatsapp/settings")).body.apiToken).toBe("••••••");
    });
  });

  it("masks the POS token and keeps it when the form posts the mask back", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`DELETE FROM whatsapp_settings WHERE id = 2`);
      expect((await w.agent.get("/api/whatsapp/settings/pos")).body).toEqual({
        instanceId: "",
        apiToken: "",
        apiTokenSet: false,
        enabled: true,
        hasCredentials: false,
      });
      await w.agent.put("/api/whatsapp/settings/pos").send({ instanceId: "2202", apiToken: POS_TOKEN });
      const read = await w.agent.get("/api/whatsapp/settings/pos");
      expect(read.body).toEqual({
        instanceId: "2202",
        apiToken: "••••••0002",
        apiTokenSet: true,
        enabled: true,
        hasCredentials: true,
      });
      // The POS form re-posts exactly what it read.
      await w.agent.put("/api/whatsapp/settings/pos").send({ ...read.body, instanceId: "2203" });
      const [row] = await w.q(`SELECT instance_id, api_token FROM whatsapp_settings WHERE id = 2`);
      expect(row).toEqual({ instance_id: "2203", api_token: POS_TOKEN });
      await w.agent.put("/api/whatsapp/settings/pos").send({ apiToken: "new-pos-token-9999" });
      expect((await w.agent.get("/api/whatsapp/settings/pos")).body.apiToken).toBe("••••••9999");
    });
  });

  it("reports a database failure on save", async () => {
    await withFactoryWorld(async (w) => {
      const res = await w.agent.put("/api/whatsapp/settings").send({ enabled: "not-a-bool" });
      expect(res.status).toBe(500);
    });
  });

  it("reports the POS instance state only when it is configured", async () => {
    await withFactoryWorld(async (w) => {
      m.posSettings.mockResolvedValueOnce(null);
      expect((await w.agent.get("/api/whatsapp/instance-state/pos")).body).toEqual({ state: "notConfigured" });
      m.state.mockResolvedValueOnce("notAuthorized");
      expect((await w.agent.get("/api/whatsapp/instance-state/pos")).body).toEqual({ state: "notAuthorized" });
      expect(m.state).toHaveBeenCalledWith("2202", "pos");
      m.posSettings.mockRejectedValueOnce(new Error("boom"));
      expect((await w.agent.get("/api/whatsapp/instance-state/pos")).status).toBe(500);
    });
  });
});

describe("send Net Position by WhatsApp", () => {
  it("refuses an empty month range and reports provider failures", async () => {
    await withFactoryWorld(async (w) => {
      const send = (body: object) => w.agent.post("/api/whatsapp/send-net-position").send(body);
      const empty = await send({ startDate: "2026-05-01", endDate: "2026-01-01" });
      expect(empty.status).toBe(400);
      expect(m.netPosition).not.toHaveBeenCalled();

      const ok = await send({ companyId: w.companyId, endDate: "2026-03-31" });
      expect(ok.status).toBe(200);
      expect(ok.body.message).toBe("Sent to 2 recipient(s)");
      const [companyId, companyName, start, end] = m.netPosition.mock.calls[0];
      expect([companyId, companyName, start, end]).toEqual([w.companyId, w.tag, "2025-03-31", "2026-03-31"]);
      expect(m.sendFile.mock.calls[0][1]).toBe(`NetPosition_${w.tag}_2026-03-31.xlsx`);

      m.sendFile.mockResolvedValueOnce({ success: false, sent: 0, errors: ["No recipients"] });
      const failed = await send({ startDate: "2026-01-01", endDate: "2026-03-31" });
      expect(failed.status).toBe(502);
      expect(failed.body.message).toBe("No recipients");
      m.sendFile.mockResolvedValueOnce({ success: false, sent: 0, errors: [] });
      expect((await send({ startDate: "2026-01-01", endDate: "2026-03-31" })).body.message).toBe("Send failed");
      m.netPosition.mockRejectedValueOnce(new Error("render failed"));
      const thrown = await send({ startDate: "2026-01-01", endDate: "2026-03-31" });
      expect(thrown.status).toBe(500);
      expect(thrown.body.message).toBe("render failed");
    });
  });
});

describe("stock and Net Position schedule settings", () => {
  it("returns defaults, saves and reads back both schedules", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`DELETE FROM whatsapp_stock_settings`);
      await w.q(`DELETE FROM net_position_export_settings`);
      expect((await w.agent.get("/api/whatsapp/stock-settings")).body).toMatchObject({
        companyId: null,
        frequency: "daily",
        sendHour: 18,
      });
      expect((await w.agent.get("/api/whatsapp/np-settings")).body).toMatchObject({
        recipientId: null,
        sendDayOfWeek: 1,
      });
      expect(
        (await w.agent.put("/api/whatsapp/stock-settings").send({ companyId: w.companyId, enabled: true })).status
      ).toBe(200);
      expect((await w.agent.get("/api/whatsapp/stock-settings")).body).toMatchObject({
        companyId: w.companyId,
        enabled: true,
        autoSend: false,
        sendDayOfWeek: 1,
      });
      const recipient = await w.one(
        `INSERT INTO whatsapp_recipients (name, chat_id, company_id) VALUES ('Boss', '243810000001@c.us', $1) RETURNING id`,
        [w.companyId]
      );
      await w.agent
        .put("/api/whatsapp/np-settings")
        .send({ recipientId: recipient, frequency: "weekly", sendDayOfWeek: 3 });
      expect((await w.agent.get("/api/whatsapp/np-settings")).body).toMatchObject({
        recipientId: recipient,
        recipientName: "Boss",
        frequency: "weekly",
        sendDayOfWeek: 3,
      });
      expect((await w.agent.put("/api/whatsapp/stock-settings").send({ sendHour: "noon" })).status).toBe(500);
      expect((await w.agent.put("/api/whatsapp/np-settings").send({ sendHour: "noon" })).status).toBe(500);
    });
  });
});

describe("manual all-company exports", () => {
  it("starts the daily WhatsApp export only for owners with a valid range", async () => {
    await withFactoryWorld(async (w) => {
      const bad = await w.agent.post("/api/daily-export/trigger-whatsapp").send({ fromDate: "31/12/2026" });
      expect(bad.status).toBe(400);
      const manager = await w.agentFor("Manager");
      expect((await manager.post("/api/daily-export/trigger-whatsapp").send({})).status).toBe(403);
      m.trigger.mockRejectedValueOnce(new Error("later failure"));
      const ok = await w.agent.post("/api/daily-export/trigger-whatsapp").send({ fromDate: "2026-01-01", toDate: "" });
      expect(ok.body).toMatchObject({ started: true });
      await vi.waitFor(() => expect(m.trigger).toHaveBeenCalledWith("2026-01-01", undefined));
      expect(m.trigger).toHaveBeenCalledTimes(1);
    });
  });

  it("zips every company, sends to an active company recipient and e-mails the result", async () => {
    await withFactoryWorld(async (w) => {
      const send = (body: object) => w.agent.post("/api/whatsapp/send-np-all-now").send(body);
      m.netPosition.mockImplementation(async (id: number) => {
        if (id === w.companyId) throw new Error("one company failed");
        return Buffer.from("xlsx");
      });
      const none = await send({});
      expect(none.status).toBe(200);
      expect(none.body.message).toBe("No WhatsApp group selected | Email: sent");

      const recipient = await w.one(
        `INSERT INTO whatsapp_recipients (name, chat_id, company_id, is_group) VALUES ('G', '1203630001@g.us', $1, true)
         RETURNING id`,
        [w.companyId]
      );
      const sent = await send({ recipientId: recipient });
      expect(sent.body.message).toBe("WhatsApp: sent | Email: sent");
      const [chatId, zip, fileName, , mime] = m.sendToChat.mock.calls[0];
      expect(chatId).toBe("1203630001@g.us");
      expect((zip as Buffer).subarray(0, 2).toString()).toBe("PK");
      expect(fileName).toMatch(/^NetPosition_AllCompanies_\d{4}-\d{2}-\d{2}\.zip$/);
      expect(mime).toBe("application/zip");

      m.sendToChat.mockResolvedValueOnce({ success: false, error: "rate limited" });
      m.email.mockResolvedValueOnce({ success: false });
      expect((await send({ recipientId: recipient })).body.message).toBe("WhatsApp: rate limited | Email: failed");
      m.settings.mockResolvedValueOnce({ enabled: false });
      m.email.mockResolvedValueOnce({ success: false, error: "smtp down" });
      expect((await send({ recipientId: recipient })).body.message).toBe("WhatsApp not enabled | Email: smtp down");
      await w.q(`UPDATE whatsapp_recipients SET active = false WHERE id = $1`, [recipient]);
      expect((await send({ recipientId: recipient })).body.message).toContain("recipient not found or inactive");
      m.email.mockRejectedValueOnce(new Error("mailer crashed"));
      expect((await send({})).status).toBe(500);
    });
  });
});
