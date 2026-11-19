/**
 * GIT WhatsApp settings and send routes (server/routes/git/gitWhatsappRoutes.ts)
 * over HTTP. The WhatsApp settings store, the GREEN API file send and the
 * containers PDF renderer are mocked at their module boundaries, so the global
 * WhatsApp settings row is never touched. Covers role refusals, missing or
 * disabled configuration, wrong-type, empty and oversized images, provider
 * failure and storage errors.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({
  getAllCompanyTransferWaSettings: vi.fn(),
  getWaSettings: vi.fn(),
  setCompanyTransferWaGroupChatId: vi.fn(),
  getAgentDutyWaCredentials: vi.fn(),
  updateAgentDutyWaGroups: vi.fn(),
  getContainersWaSettings: vi.fn(),
  updateContainersWaSettings: vi.fn(),
  sendWhatsAppFileToChatId: vi.fn(),
}));
const pdf = vi.hoisted(() => ({ generateContainersPdf: vi.fn() }));
vi.mock("../server/services/whatsappService", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/whatsappService")>();
  return { ...actual, ...wa };
});
vi.mock("../server/helpers/generateContainersPdf", () => pdf);

import request from "supertest";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";
import { signInAdmin, signInRole, type Agent } from "./helpers/routeCoverageSession";

const PREFIX = "gitwa";
const PNG = `data:image/png;base64,${Buffer.from("png-bytes").toString("base64")}`;
const JPG = `data:image/jpg;base64,${Buffer.from("jpg-bytes").toString("base64")}`;
let ctx: TestContext;
let admin: Agent;
let manager: Agent;

const credentials = { instanceId: "1101", apiToken: "tok", enabled: true };

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  admin = await signInAdmin(ctx, PREFIX);
  manager = await signInRole(ctx, PREFIX, "Manager");
}, 60000);

afterAll(async () => {
  await cleanupTestData(PREFIX);
  closeTestServer();
}, 60000);

beforeEach(() => {
  for (const fn of Object.values(wa)) fn.mockReset();
  wa.getWaSettings.mockResolvedValue(credentials);
  wa.getAllCompanyTransferWaSettings.mockResolvedValue([{ companyId: ctx.companyId, groupChatId: "g@g.us" }]);
  wa.getAgentDutyWaCredentials.mockResolvedValue({ ...credentials, groups: { kabila: "111@g.us" } });
  wa.getContainersWaSettings.mockResolvedValue({
    ...credentials,
    groupChatId: "222@g.us",
    scheduleEnabled: true,
    scheduleHour: 9,
    lastSentAt: null,
  });
  wa.sendWhatsAppFileToChatId.mockResolvedValue({ success: true });
  pdf.generateContainersPdf.mockReset().mockResolvedValue({ buffer: Buffer.from("%PDF") });
});

describe("settings", () => {
  it("reads transfer, agent-duty and container settings with credential flags", async () => {
    expect((await admin.get("/api/git/transfer-wa-settings")).body).toEqual({
      companies: [{ companyId: ctx.companyId, groupChatId: "g@g.us" }],
      hasCredentials: true,
      waEnabled: true,
    });
    wa.getWaSettings.mockResolvedValue(null);
    wa.getAgentDutyWaCredentials.mockResolvedValue(null);
    wa.getContainersWaSettings.mockResolvedValue(null);
    expect((await admin.get("/api/git/agent-duty-wa-settings")).body).toEqual({
      groups: {},
      hasCredentials: false,
      waEnabled: false,
    });
    expect((await admin.get("/api/git/containers-wa-settings")).body).toEqual({
      groupChatId: "",
      scheduleEnabled: false,
      scheduleHour: 8,
      lastSentAt: null,
      hasCredentials: false,
      waEnabled: false,
    });
  });

  it("answers 500 when the settings store fails", async () => {
    wa.getWaSettings.mockRejectedValue(new Error("settings offline"));
    for (const url of [
      "/api/git/transfer-wa-settings",
      "/api/git/agent-duty-wa-settings",
      "/api/git/containers-wa-settings",
    ]) {
      const res = await admin.get(url);
      expect([res.status, res.body.message]).toEqual([500, "settings offline"]);
    }
  });

  it("refuses settings writes below Owner and anonymous reads", async () => {
    expect((await request(ctx.app).get("/api/git/transfer-wa-settings")).status).toBe(401);
    expect(
      (await manager.patch(`/api/git/transfer-wa-settings/${ctx.companyId}`).send({ groupChatId: "x" })).status
    ).toBe(403);
    expect((await manager.patch("/api/git/agent-duty-wa-settings").send({ groups: {} })).status).toBe(403);
    expect((await manager.patch("/api/git/containers-wa-settings").send({})).status).toBe(403);
    expect(wa.setCompanyTransferWaGroupChatId).not.toHaveBeenCalled();
  });

  it("saves settings with defaults and reports bad ids and store failures", async () => {
    expect((await admin.patch("/api/git/transfer-wa-settings/abc").send({})).status).toBe(400);
    expect((await admin.patch(`/api/git/transfer-wa-settings/${ctx.companyId}`).send({})).body).toEqual({ ok: true });
    expect(wa.setCompanyTransferWaGroupChatId).toHaveBeenCalledWith(ctx.companyId, "");
    expect((await admin.patch("/api/git/agent-duty-wa-settings").send({})).body).toEqual({ ok: true });
    expect(wa.updateAgentDutyWaGroups).toHaveBeenCalledWith({});
    expect(
      (
        await admin
          .patch("/api/git/containers-wa-settings")
          .send({ groupChatId: "1@g.us", scheduleEnabled: 1, scheduleHour: "7" })
      ).status
    ).toBe(200);
    expect(wa.updateContainersWaSettings).toHaveBeenCalledWith("1@g.us", true, 7);

    wa.setCompanyTransferWaGroupChatId.mockRejectedValue(new Error("write failed"));
    wa.updateAgentDutyWaGroups.mockRejectedValue(new Error("write failed"));
    wa.updateContainersWaSettings.mockRejectedValue(new Error("write failed"));
    expect((await admin.patch(`/api/git/transfer-wa-settings/${ctx.companyId}`).send({})).status).toBe(500);
    expect((await admin.patch("/api/git/agent-duty-wa-settings").send({})).status).toBe(500);
    expect((await admin.patch("/api/git/containers-wa-settings").send({})).status).toBe(500);
  });
});

describe("agent duty send", () => {
  const send = (body: Record<string, unknown>) => admin.post("/api/git/send-agent-duty-whatsapp").send(body);

  it("refuses missing input, missing configuration and disabled sending", async () => {
    expect(
      (await manager.post("/api/git/send-agent-duty-whatsapp").send({ imageBase64: PNG, agentName: "kabila" })).status
    ).toBe(403);
    expect((await send({ agentName: "kabila" })).status).toBe(400);
    expect((await send({ imageBase64: PNG })).status).toBe(400);
    wa.getAgentDutyWaCredentials.mockResolvedValueOnce(null);
    expect((await send({ imageBase64: PNG, agentName: "kabila" })).body.message).toBe("WhatsApp not configured.");
    expect((await send({ imageBase64: PNG, agentName: "Nobody" })).body.message).toContain(
      'No WhatsApp group configured for agent "Nobody"'
    );
    wa.getAgentDutyWaCredentials.mockResolvedValueOnce({
      instanceId: "",
      apiToken: "",
      enabled: true,
      groups: { kabila: "1@g.us" },
    });
    expect((await send({ imageBase64: PNG, agentName: "kabila" })).body.message).toBe(
      "WhatsApp credentials not configured."
    );
    wa.getAgentDutyWaCredentials.mockResolvedValueOnce({
      ...credentials,
      enabled: false,
      groups: { kabila: "1@g.us" },
    });
    expect((await send({ imageBase64: PNG, agentName: "kabila" })).body.message).toBe("WhatsApp sending is disabled.");
    expect(wa.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
  });

  it("refuses non-image payloads and empty images", async () => {
    expect((await send({ imageBase64: "data:image/gif;base64,R0lG", agentName: "kabila" })).body.message).toContain(
      "Invalid image payload"
    );
    const gif = await admin
      .post("/api/git/send-agent-duty-whatsapp")
      .field("agentName", "kabila")
      .attach("image", Buffer.from("GIF89a"), { filename: "duty.gif", contentType: "image/gif" });
    expect(gif.status).toBe(400);
    expect(gif.body.message).toContain("Invalid image payload");
    const empty = await admin
      .post("/api/git/send-agent-duty-whatsapp")
      .field("agentName", "kabila")
      .attach("image", Buffer.alloc(0), { filename: "duty.png", contentType: "image/png" });
    expect(empty.body.message).toBe("Image payload is empty.");
    expect(wa.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
  });

  it("sends uploaded and data-URL images with a normalised file name", async () => {
    const upload = await admin
      .post("/api/git/send-agent-duty-whatsapp")
      .field("agentName", "Kabila")
      .attach("image", Buffer.from("jpeg"), { filename: "duty.jpeg", contentType: "image/jpeg" });
    expect(upload.body).toEqual({ ok: true, message: "Sent to WhatsApp group for Kabila." });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[0]).toEqual([
      "111@g.us",
      Buffer.from("jpeg"),
      "duty.jpeg",
      "",
      "image/jpeg",
    ]);
    await send({ imageBase64: JPG, agentName: "kabila", fileName: "report.png" });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[1].slice(2)).toEqual(["report.jpg", "", "image/jpeg"]);
    await send({ imageBase64: PNG, agentName: "kabila" });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[2][2]).toMatch(/^AgentDuty_kabila_\d{4}-\d{2}-\d{2}\.png$/);
  });

  it("reports provider failures and thrown errors", async () => {
    wa.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: false, error: "Group not found" });
    expect((await send({ imageBase64: PNG, agentName: "kabila" })).body.message).toBe("Group not found");
    wa.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: false });
    expect((await send({ imageBase64: PNG, agentName: "kabila" })).body.message).toBe("Failed to send");
    wa.sendWhatsAppFileToChatId.mockRejectedValueOnce(new Error("timeout"));
    const thrown = await send({ imageBase64: PNG, agentName: "kabila" });
    expect([thrown.status, thrown.body.message]).toEqual([500, "timeout"]);
  });
});

describe("containers send", () => {
  const send = (body: Record<string, unknown> = {}) => admin.post("/api/git/send-containers-whatsapp").send(body);

  it("refuses below Owner, without a group, credentials or enabled sending", async () => {
    expect((await manager.post("/api/git/send-containers-whatsapp").send({})).status).toBe(403);
    wa.getContainersWaSettings.mockResolvedValueOnce(null);
    expect((await send()).body.message).toContain("No WhatsApp group configured");
    wa.getContainersWaSettings.mockResolvedValueOnce({
      groupChatId: "2@g.us",
      instanceId: "",
      apiToken: "",
      enabled: true,
    });
    expect((await send()).body.message).toBe("WhatsApp credentials not configured.");
    wa.getContainersWaSettings.mockResolvedValueOnce({ groupChatId: "2@g.us", ...credentials, enabled: false });
    expect((await send()).body.message).toBe("WhatsApp sending is disabled.");
    expect(wa.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
  });

  it("refuses wrong-type, empty and oversized images", async () => {
    expect((await send({ imageBase64: "data:text/html;base64,PGI+" })).body.message).toContain("Invalid image payload");
    expect((await send({ imageBase64: "data:image/png;base64,=" })).body.message).toBe(
      "Decoded image buffer is empty."
    );
    const big = `data:image/png;base64,${Buffer.alloc(2 * 1024 * 1024 + 10, 1).toString("base64")}`;
    const tooLarge = await send({ imageBase64: big });
    expect(tooLarge.status).toBe(413);
    expect(wa.sendWhatsAppFileToChatId).not.toHaveBeenCalled();
  });

  it("sends an image or the generated PDF and reports provider failure", async () => {
    expect((await send({ imageBase64: JPG, fileName: "table.png" })).body).toEqual({
      ok: true,
      message: "Sent to WhatsApp group.",
    });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[0].slice(0, 2)).toEqual(["222@g.us", Buffer.from("jpg-bytes")]);
    expect(wa.sendWhatsAppFileToChatId.mock.calls[0].slice(2)).toEqual(["table.jpg", "", "image/jpeg"]);
    await send({ imageBase64: PNG });
    expect(wa.sendWhatsAppFileToChatId.mock.calls[1][2]).toMatch(/^Containers_\d{4}-\d{2}-\d{2}\.png$/);
    await send();
    expect(wa.sendWhatsAppFileToChatId.mock.calls[2].slice(3)).toEqual(["", "application/pdf"]);
    wa.sendWhatsAppFileToChatId.mockResolvedValueOnce({ success: false });
    expect((await send()).body.message).toBe("Failed to send");
    pdf.generateContainersPdf.mockRejectedValueOnce(new Error("pdf failed"));
    expect((await send()).status).toBe(500);
  });
});
