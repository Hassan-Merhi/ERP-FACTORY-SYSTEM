/**
 * Manual cost-free Stock Transfer Order workbook delivery to configured
 * WhatsApp groups (stockTransferExportWhatsAppRoutes.ts), through the real
 * HTTP app in one rolled-back transaction per test. The GREEN API upload is
 * mocked at the whatsappService boundary; the workbook it receives is the real
 * no-cost XLSX, inspected for the absence of any rate or cost column.
 */
import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({ settings: vi.fn(), sendFile: vi.fn() }));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getWaSettings: wa.settings,
  sendWhatsAppFileToChatId: wa.sendFile,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const GROUPS = "/api/stock-transfer-order/whatsapp-groups";
const SEND = "/api/stock-transfer-order/send-whatsapp";
const item = { stockItemName: "Sacks", sourceLocationName: "Yard", quantity: 5, rate: 9.99 };

beforeEach(() => {
  wa.settings.mockReset().mockResolvedValue({ enabled: true, instanceId: "1101", apiToken: "tok" });
  wa.sendFile.mockReset().mockResolvedValue({ success: true });
});

const groupRows = (w: FactoryWorld) =>
  w.q(`SELECT name, chat_id FROM stock_transfer_export_wa_groups WHERE company_id = $1 ORDER BY id`, [w.companyId]);

describe("transfer export WhatsApp groups", () => {
  it("lists, saves, renames and removes company groups, refusing invalid ids", async () => {
    await withFactoryWorld(async (w) => {
      const empty = await w.agent.get(GROUPS);
      expect(empty.body).toEqual({ groups: [], connected: true });
      expect((await w.agent.post(GROUPS).send({ name: "", chatId: "12345@g.us" })).status).toBe(400);
      expect((await w.agent.post(GROUPS).send({ name: "Depot", chatId: "243810000@c.us" })).status).toBe(400);
      expect(await groupRows(w)).toEqual([]);

      const saved = await w.agent.post(GROUPS).send({ name: "Depot", chatId: "120363000000001@g.us" });
      expect(saved.status).toBe(200);
      const renamed = await w.agent.post(GROUPS).send({ name: "Depot B", chatId: "120363000000001@g.us" });
      expect(renamed.body.id).toBe(saved.body.id);
      expect(await groupRows(w)).toEqual([{ name: "Depot B", chat_id: "120363000000001@g.us" }]);

      wa.settings.mockResolvedValueOnce(null);
      expect((await w.agent.get(GROUPS)).body.connected).toBe(false);
      expect((await w.agent.delete(`${GROUPS}/abc`)).status).toBe(400);
      expect((await w.agent.delete(`${GROUPS}/${saved.body.id}`)).status).toBe(200);
      expect(await groupRows(w)).toEqual([]);
    });
  });

  it("caps a company at 30 groups and reports a load failure", async () => {
    await withFactoryWorld(async (w) => {
      for (let i = 0; i < 30; i++) {
        await w.q(`INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, $2, $3)`, [
          w.companyId,
          `G${i}`,
          `1203630000${String(i).padStart(5, "0")}@g.us`,
        ]);
      }
      const capped = await w.agent.post(GROUPS).send({ name: "One more", chatId: "99999999@g.us" });
      expect(capped.status).toBe(400);
      expect(capped.body.message).toContain("Maximum 30");
      wa.settings.mockRejectedValueOnce(new Error("db down"));
      expect((await w.agent.get(GROUPS)).status).toBe(500);
    });
  });

  it("restricts editing to Admin/Owner/Developer and listing to senders", async () => {
    await withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.get(GROUPS)).status).toBe(200);
      expect((await manager.post(GROUPS).send({ name: "X", chatId: "12345@g.us" })).status).toBe(403);
      expect((await manager.delete(`${GROUPS}/1`)).status).toBe(403);
      const viewer = await w.agentFor("Viewer");
      expect((await viewer.get(GROUPS)).status).toBe(403);
    });
  });
});

describe("send transfer export to WhatsApp", () => {
  async function twoGroups(w: FactoryWorld) {
    const a = await w.one(
      `INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, 'A', '111111@g.us') RETURNING id`,
      [w.companyId]
    );
    const b = await w.one(
      `INSERT INTO stock_transfer_export_wa_groups (company_id, name, chat_id) VALUES ($1, 'B', '222222@g.us') RETURNING id`,
      [w.companyId]
    );
    return [a, b];
  }

  it("validates groups, items, date and destination before sending anything", async () => {
    await withFactoryWorld(async (w) => {
      const [a, b] = await twoGroups(w);
      const valid = { groupIds: [a], items: [item], transferDate: "2026-03-01", destination: "Depot" };
      const send = (body: object) => w.agent.post(SEND).send(body);
      for (const groupIds of [[], [a, a], [a, b, 3], [0], "1"]) {
        expect((await send({ ...valid, groupIds })).status).toBe(400);
      }
      for (const patch of [
        { items: [] },
        { items: [null] },
        { items: [{ ...item, quantity: 0 }] },
        { items: [{ ...item, stockItemName: "" }] },
        { transferDate: "01/03/2026" },
        { transferDate: "2026-13-45" },
        { destination: "" },
      ]) {
        const res = await send({ ...valid, ...patch });
        expect(res.status, JSON.stringify(patch)).toBe(400);
        expect(res.body.message).toContain("Invalid transfer order");
      }
      const foreign = await send({ ...valid, groupIds: [999999999] });
      expect(foreign.body.message).toContain("no longer configured");
      wa.settings.mockResolvedValueOnce({ enabled: false, instanceId: "1", apiToken: "t" });
      expect((await send(valid)).body.message).toContain("Connect and enable");
      expect(wa.sendFile).not.toHaveBeenCalled();
    });
  });

  it("sends a cost-free workbook to each group and reports per-group failures", async () => {
    await withFactoryWorld(async (w) => {
      const [a, b] = await twoGroups(w);
      wa.sendFile.mockResolvedValueOnce({ success: true }).mockResolvedValueOnce({ success: false });
      const res = await w.agent
        .post(SEND)
        .send({ groupIds: [a, b], items: [item], transferDate: "2026-03-01", destination: "Depot/North" });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: false, sent: 1, failed: 1 });
      expect(res.body.results[1]).toMatchObject({ groupId: b, success: false, error: "Send failed" });
      const [chatId, buffer, fileName, caption] = wa.sendFile.mock.calls[0];
      expect(chatId).toBe("111111@g.us");
      expect(fileName).toBe("Truck_Trip_Depot_North_2026-03-01.xlsx");
      expect(caption).toContain("without cost");
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
      const text: string[] = [];
      workbook.worksheets[0].eachRow((row) => text.push((row.values as unknown[]).join("|")));
      expect(text.join("\n")).toContain("Sacks");
      expect(text.join("\n")).not.toContain("9.99");

      wa.sendFile.mockRejectedValueOnce(new Error("upload timeout"));
      const thrown = await w.agent
        .post(SEND)
        .send({ groupIds: [a], items: [item], transferDate: "2026-03-01", destination: "Depot" });
      expect(thrown.body.results[0]).toMatchObject({ success: false, error: "upload timeout" });
    });
  });

  it("returns 500 when the WhatsApp settings cannot be read", async () => {
    await withFactoryWorld(async (w) => {
      const [a] = await twoGroups(w);
      wa.settings.mockRejectedValueOnce(new Error("settings down"));
      const res = await w.agent
        .post(SEND)
        .send({ groupIds: [a], items: [item], transferDate: "2026-03-01", destination: "Depot" });
      expect(res.status).toBe(500);
      expect(res.body.message).toContain("Unable to send");
    });
  });
});
