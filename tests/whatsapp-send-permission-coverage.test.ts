/**
 * The company WhatsApp account: manual sends (send-net-position,
 * send-np-all-now, send-stock-report) and the recipient list they send to
 * need the named export permission exp_whatsapp_send. The chat pickers and
 * instance-state checks stay readable by any signed-in user.
 *
 * Real HTTP app in one rolled-back transaction per test; Green API, the
 * report renderers and the e-mail transport are mocked at their module
 * boundaries so a refusal can prove that nothing was sent.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  settings: vi.fn(),
  posSettings: vi.fn(),
  state: vi.fn(),
  chats: vi.fn(),
  sendFile: vi.fn(),
  sendToChat: vi.fn(),
  netPosition: vi.fn(),
  stockPdf: vi.fn(),
  email: vi.fn(),
}));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getWaSettings: m.settings,
  getPosWaSettings: m.posSettings,
  getStrictGreenMainInstanceState: m.state,
  fetchGreenApiChats: m.chats,
  sendWhatsAppFile: m.sendFile,
  sendWhatsAppFileToChatId: m.sendToChat,
}));
vi.mock("../server/helpers/generateNetPositionExcel", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/helpers/generateNetPositionExcel")>()),
  generateNetPositionExcel: m.netPosition,
}));
vi.mock("../server/helpers/generateStockPdf", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/helpers/generateStockPdf")>()),
  generateStockPdf: m.stockPdf,
}));
vi.mock("../server/services/emailService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/emailService")>()),
  sendExportEmail: m.email,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const PERMISSION = "exp_whatsapp_send";

beforeEach(() => {
  m.settings.mockReset().mockResolvedValue({ enabled: true, instanceId: "1101", apiToken: "tok" });
  m.posSettings.mockReset().mockResolvedValue({ enabled: true, instanceId: "2202", apiToken: "pos" });
  m.state.mockReset().mockResolvedValue("authorized");
  m.chats.mockReset().mockResolvedValue([{ id: "1203630001@g.us", name: "Sales" }]);
  m.sendFile.mockReset().mockResolvedValue({ success: true, sent: 1, errors: [] });
  m.sendToChat.mockReset().mockResolvedValue({ success: true });
  m.netPosition.mockReset().mockResolvedValue(Buffer.from("xlsx"));
  m.stockPdf.mockReset().mockResolvedValue({ buffer: Buffer.from("%PDF"), pageCount: 1, rowCount: 1 });
  m.email.mockReset().mockResolvedValue({ success: true });
});

const sendMocks = () => [m.sendFile, m.sendToChat, m.netPosition, m.stockPdf, m.email];

async function seedRecipient(w: FactoryWorld) {
  return w.one(
    `INSERT INTO whatsapp_recipients (company_id, chat_id, name, is_group, active)
     VALUES ($1, '1203630001@g.us', 'Sales', true, true) RETURNING id`,
    [w.companyId]
  );
}

const recipientsState = (w: FactoryWorld) =>
  w.q(`SELECT id, chat_id, name, is_group, active FROM whatsapp_recipients WHERE company_id = $1 ORDER BY id`, [
    w.companyId,
  ]);

async function denyRole(w: FactoryWorld, role: string) {
  await w.q(
    `INSERT INTO role_feature_permissions (company_id, role, feature_key, enabled) VALUES ($1, $2, $3, false)
       ON CONFLICT DO NOTHING`,
    [w.companyId, role, PERMISSION]
  );
}

function guardedCalls(recipientId: number, companyId: number) {
  return [
    { method: "get", url: "/api/whatsapp/recipients" },
    { method: "post", url: "/api/whatsapp/recipients", body: { chatId: "96170000001", name: "Intruder" } },
    { method: "put", url: `/api/whatsapp/recipients/${recipientId}`, body: { name: "Renamed", active: false } },
    { method: "delete", url: `/api/whatsapp/recipients/${recipientId}` },
    {
      method: "post",
      url: "/api/whatsapp/send-net-position",
      body: { startDate: "2026-01-01", endDate: "2026-03-31" },
    },
    { method: "post", url: "/api/whatsapp/send-np-all-now", body: { recipientId } },
    { method: "post", url: "/api/whatsapp/send-stock-report", body: { companyId, recipientId } },
  ] as const;
}

describe("WhatsApp send permission", () => {
  it("refuses every send and recipient call without exp_whatsapp_send, sending and writing nothing", async () => {
    await withFactoryWorld(async (w) => {
      const recipientId = await seedRecipient(w);
      await denyRole(w, "Manager");
      await denyRole(w, "Owner");
      const before = await recipientsState(w);
      // Manager and Owner are allowed by default, so they are refused only by the
      // explicit deny row; Normal User is denied by default.
      for (const role of ["Manager", "Owner", "Normal User"]) {
        const agent = await w.agentFor(role);
        for (const call of guardedCalls(recipientId, w.companyId)) {
          const req = agent[call.method](call.url);
          const res = "body" in call ? await req.send(call.body) : await req;
          expect(res.status, `${role} ${call.method.toUpperCase()} ${call.url}`).toBe(403);
          expect(res.body).toMatchObject({ key: PERMISSION, permType: "export" });
          expect(JSON.stringify(res.body)).not.toContain("1203630001@g.us");
        }
      }
      for (const mock of sendMocks()) expect(mock).not.toHaveBeenCalled();
      expect(await recipientsState(w)).toEqual(before);
    });
  });

  it("keeps chats and instance state readable without the permission", async () => {
    await withFactoryWorld(async (w) => {
      await denyRole(w, "Manager");
      const manager = await w.agentFor("Manager");
      const chats = await manager.get("/api/whatsapp/chats");
      expect(chats.status).toBe(200);
      expect(chats.body).toEqual([{ id: "1203630001@g.us", name: "Sales" }]);
      expect((await manager.get("/api/whatsapp/chats/pos")).status).toBe(200);
      expect((await manager.get("/api/whatsapp/instance-state/main")).body).toEqual({ state: "authorized" });
      expect((await manager.get("/api/whatsapp/instance-state/pos")).body).toEqual({ state: "authorized" });
      for (const mock of sendMocks()) expect(mock).not.toHaveBeenCalled();
    });
  });

  it("lets a Manager holding the permission manage recipients and send", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      const created = await manager.post("/api/whatsapp/recipients").send({ chatId: "1203630002@g.us", name: "Ops" });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ chatId: "1203630002@g.us", name: "Ops", isGroup: true, active: true });
      const id = created.body.id as number;
      expect((await manager.put(`/api/whatsapp/recipients/${id}`).send({ name: "Ops desk" })).status).toBe(200);
      const listed = await manager.get("/api/whatsapp/recipients");
      expect(listed.status).toBe(200);
      expect(listed.body).toEqual([{ id, chatId: "1203630002@g.us", name: "Ops desk", isGroup: true, active: true }]);

      const net = await manager
        .post("/api/whatsapp/send-net-position")
        .send({ startDate: "2026-01-01", endDate: "2026-03-31" });
      expect(net.status).toBe(200);
      expect(m.sendFile).toHaveBeenCalledTimes(1);

      const stock = await manager
        .post("/api/whatsapp/send-stock-report")
        .send({ companyId: w.companyId, recipientId: id });
      expect(stock.status).toBe(200);
      expect(stock.body.message).toBe("Stock PDF + Net Position Excel sent to 1203630002@g.us");
      expect(m.sendToChat.mock.calls.map((c) => c[0])).toEqual(["1203630002@g.us", "1203630002@g.us"]);

      expect((await manager.delete(`/api/whatsapp/recipients/${id}`)).status).toBe(200);
      expect(await recipientsState(w)).toEqual([]);
    });
  });

  it("lets an Owner holding the permission send the all-company Net Position", async () => {
    await withFactoryWorld(async (w) => {
      const recipientId = await seedRecipient(w);
      const owner = await w.agentFor("Owner");
      const res = await owner.post("/api/whatsapp/send-np-all-now").send({ recipientId });
      expect(res.status).toBe(200);
      expect(res.body.message).toBe("WhatsApp: sent | Email: sent");
      expect(m.sendToChat).toHaveBeenCalledTimes(1);
      expect(m.sendToChat.mock.calls[0][0]).toBe("1203630001@g.us");
    });
  });
});
