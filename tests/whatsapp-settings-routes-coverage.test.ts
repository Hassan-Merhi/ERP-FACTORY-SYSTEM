/**
 * General WhatsApp settings and manual Net Position sends
 * (registerWhatsAppRoutesPart1.ts / registerWhatsAppRoutesPart2.ts) through
 * the real HTTP app in one rolled-back transaction per test, so the singleton
 * settings rows never leak. GREEN API, the e-mail transport, the scheduler
 * entry point and the Net Position workbook renderer are mocked at their
 * module boundaries.
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

import { withFactoryWorld } from "./helpers/rolledBackFactoryApp";

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

describe("WhatsApp main settings", () => {
  it("returns defaults without a row, masks the token and preserves it on save", async () => {
    await withFactoryWorld(async (w) => {
      await w.q(`DELETE FROM whatsapp_settings WHERE id = 1`);
      expect((await w.agent.get("/api/whatsapp/settings")).body).toEqual({
        instanceId: "",
        apiToken: "",
        enabled: false,
        monthlyAutoSend: false,
      });
      m.settings.mockResolvedValueOnce(null);
      const created = await w.agent.put("/api/whatsapp/settings").send({ instanceId: "1101", apiToken: "secret" });
      expect(created.status).toBe(200);
      const read = await w.agent.get("/api/whatsapp/settings");
      expect(read.body).toMatchObject({ instanceId: "1101", apiToken: "••••••", enabled: false, hasCredentials: true });

      m.settings.mockResolvedValueOnce({
        instanceId: "1101",
        apiToken: "secret",
        enabled: false,
        monthlyAutoSend: true,
        dailyAutoSend: false,
        dailyRecipientId: null,
      });
      await w.agent.put("/api/whatsapp/settings").send({ apiToken: "••••••", enabled: true });
      const [row] = await w.q(`SELECT api_token, enabled, monthly_auto_send FROM whatsapp_settings WHERE id = 1`);
      expect(row).toEqual({ api_token: "secret", enabled: true, monthly_auto_send: true });
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
