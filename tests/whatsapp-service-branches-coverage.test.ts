import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getWaSettings: vi.fn(),
  getWaSettingsById: vi.fn(),
  getActiveRecipients: vi.fn(),
  fetchGreenApiWithAuthFallback: vi.fn(),
  requestGreenApiUpload: vi.fn(),
  uploadGreenApiWithAuthFallback: vi.fn(),
}));

vi.mock("../server/services/whatsappSettingsStore", () => ({
  getWaSettings: h.getWaSettings,
  getWaSettingsById: h.getWaSettingsById,
  getActiveRecipients: h.getActiveRecipients,
  normaliseChatId: (value: string) => value,
}));
vi.mock("../server/services/whatsappGreenApiTransport", () => ({
  greenApiRequestInit: (init: RequestInit) => init,
  baseUrl: (id: string, token: string, method: string) => `https://green.test/waInstance${id}/${method}/${token}`,
  fetchGreenApiWithAuthFallback: h.fetchGreenApiWithAuthFallback,
  requestGreenApiUpload: h.requestGreenApiUpload,
  uploadGreenApiWithAuthFallback: h.uploadGreenApiWithAuthFallback,
  getGreenApiHost: () => "green.test",
}));

import {
  getPosWaSettings,
  sendApprovedStockTransferOrderWorkbook,
  sendStockTransferOrderApprovalRequest,
  sendWhatsAppFile,
  sendWhatsAppFileByUploadPos,
  sendWhatsAppFileToChatId,
  sendWhatsAppFileToChatIdPos,
  sendWhatsAppText,
  sendWhatsAppTextToChatId,
  sendWhatsAppTextToChatIdPos,
} from "../server/services/whatsappService";

const settings = (overrides: Record<string, unknown> = {}) => ({
  instanceId: "1101",
  apiToken: "token",
  enabled: true,
  monthlyAutoSend: false,
  dailyAutoSend: false,
  dailyRecipientId: null,
  ...overrides,
});
const ok = (body: unknown = { idMessage: "ABCDEF123" }) => new Response(JSON.stringify(body), { status: 200 });
const fail = (status: number, body = "nope") => new Response(body, { status });
const fetchMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POS settings resolution", () => {
  it("prefers instance 2, falls back to an enabled copy of instance 1, else null", async () => {
    h.getWaSettingsById.mockImplementation(async (id: number) => (id === 2 ? settings({ instanceId: "2" }) : null));
    expect((await getPosWaSettings())?.instanceId).toBe("2");

    h.getWaSettingsById.mockImplementation(async (id: number) =>
      id === 2 ? settings({ apiToken: "" }) : settings({ instanceId: "1", enabled: false })
    );
    expect(await getPosWaSettings()).toMatchObject({ instanceId: "1", enabled: true });

    h.getWaSettingsById.mockImplementation(async (id: number) => (id === 2 ? null : settings({ instanceId: "" })));
    expect(await getPosWaSettings()).toBeNull();
  });
});

describe("sendStockTransferOrderApprovalRequest", () => {
  const group = "120363123456@g.us";

  it("refuses when the main instance is disabled or the input is invalid, without sending", async () => {
    h.getWaSettings.mockResolvedValueOnce(null);
    expect(await sendStockTransferOrderApprovalRequest(group, "hi")).toMatchObject({
      outcome: "failed",
      instanceId: "",
    });
    h.getWaSettings.mockResolvedValueOnce(settings({ enabled: false }));
    expect((await sendStockTransferOrderApprovalRequest(group, "hi")).outcome).toBe("failed");
    h.getWaSettings.mockResolvedValue(settings());
    expect(await sendStockTransferOrderApprovalRequest("123@c.us", "hi")).toMatchObject({
      outcome: "failed",
      instanceId: "1101",
      error: "Approval group or message is invalid.",
    });
    expect((await sendStockTransferOrderApprovalRequest(group, "")).outcome).toBe("failed");
    expect((await sendStockTransferOrderApprovalRequest(group, "x".repeat(19_001))).outcome).toBe("failed");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps network errors, rejections, missing ids and accepted sends", async () => {
    h.getWaSettings.mockResolvedValue(settings());
    fetchMock.mockRejectedValueOnce(new Error("ECONNRESET"));
    expect((await sendStockTransferOrderApprovalRequest(group, "hi")).outcome).toBe("uncertain");
    fetchMock.mockResolvedValueOnce(fail(400));
    expect(await sendStockTransferOrderApprovalRequest(group, "hi")).toMatchObject({
      outcome: "failed",
      error: "WhatsApp rejected the request (HTTP 400).",
    });
    fetchMock.mockResolvedValueOnce(new Response("not json", { status: 200 }));
    expect((await sendStockTransferOrderApprovalRequest(group, "hi")).outcome).toBe("uncertain");
    fetchMock.mockResolvedValueOnce(ok({ idMessage: "   " }));
    expect((await sendStockTransferOrderApprovalRequest(group, "hi")).outcome).toBe("uncertain");
    fetchMock.mockResolvedValueOnce(ok({ idMessage: " MSG1 " }));
    expect(await sendStockTransferOrderApprovalRequest(group, "hi")).toEqual({
      outcome: "accepted",
      instanceId: "1101",
      idMessage: "MSG1",
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://green.test/waInstance1101/sendMessage/token",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ chatId: group, message: "hi" }) })
    );
  });
});

describe("sendApprovedStockTransferOrderWorkbook", () => {
  const chat = "120363123456@g.us";
  const book = Buffer.from("xlsx-bytes");

  it("refuses a changed or disabled instance and invalid inputs without uploading", async () => {
    h.getWaSettings.mockResolvedValueOnce(settings({ instanceId: "other" }));
    expect((await sendApprovedStockTransferOrderWorkbook("1101", chat, book, "a.xlsx", "c")).error).toContain(
      "no longer configured"
    );
    h.getWaSettings.mockResolvedValueOnce(null);
    expect((await sendApprovedStockTransferOrderWorkbook("1101", chat, book, "a.xlsx", "c")).outcome).toBe("failed");
    h.getWaSettings.mockResolvedValue(settings());
    const invalid: Array<[string, unknown, string, string]> = [
      ["bad-chat", book, "a.xlsx", ""],
      [chat, "not a buffer", "a.xlsx", ""],
      [chat, Buffer.alloc(0), "a.xlsx", ""],
      [chat, book, "a.pdf", ""],
      [chat, book, "a.xlsx", "c".repeat(901)],
    ];
    for (const [chatId, workbook, name, caption] of invalid) {
      const result = await sendApprovedStockTransferOrderWorkbook("1101", chatId, workbook as Buffer, name, caption);
      expect(result).toEqual({ outcome: "failed", error: "Invalid approved workbook or WhatsApp recipient." });
    }
    expect(h.requestGreenApiUpload).not.toHaveBeenCalled();
  });

  it("classifies provider responses without retrying", async () => {
    h.getWaSettings.mockResolvedValue(settings());
    const send = () => sendApprovedStockTransferOrderWorkbook("1101", "971500000000@c.us", book, "order_1.xlsx", "cap");
    h.requestGreenApiUpload.mockRejectedValueOnce(new Error("timeout"));
    expect((await send()).outcome).toBe("uncertain");
    for (const status of [500, 429, 408]) {
      h.requestGreenApiUpload.mockResolvedValueOnce(fail(status));
      expect((await send()).error).toContain(`ambiguous upload response (${status})`);
    }
    h.requestGreenApiUpload.mockResolvedValueOnce(fail(400));
    expect(await send()).toEqual({ outcome: "failed", error: "GREEN API rejected the upload (HTTP 400)." });
    h.requestGreenApiUpload.mockResolvedValueOnce(ok({ idMessage: "bad id!" }));
    expect((await send()).outcome).toBe("uncertain");
    h.requestGreenApiUpload.mockResolvedValueOnce(new Response("{", { status: 200 }));
    expect((await send()).outcome).toBe("uncertain");
    h.requestGreenApiUpload.mockResolvedValueOnce(ok({ idMessage: "BAE5F00D:1" }));
    expect(await send()).toEqual({ outcome: "accepted", idMessage: "BAE5F00D:1" });
    expect(h.requestGreenApiUpload).toHaveBeenCalledTimes(8);
  });
});

describe("single-chat text senders", () => {
  it.each([
    ["main", sendWhatsAppTextToChatId, () => h.getWaSettings],
    ["pos", sendWhatsAppTextToChatIdPos, () => h.getWaSettingsById],
  ] as const)(
    "%s refuses missing credentials and disabled sending, then reports provider errors",
    async (_n, send, src) => {
      src().mockResolvedValue(null);
      expect(await send("1@c.us", "hi")).toEqual({ success: false, error: "WhatsApp credentials not configured" });
      src().mockResolvedValue(settings({ enabled: false }));
      expect(await send("1@c.us", "hi")).toEqual({ success: false, error: "WhatsApp sending is disabled" });
      src().mockResolvedValue(settings());
      h.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(fail(466, "quota"));
      expect(await send("1@c.us", "hi")).toEqual({ success: false, error: "Green API 466: quota" });
      h.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(ok());
      expect(await send("1@c.us", "hi")).toEqual({ success: true });
    }
  );

  it("pos senders refuse a disabled POS instance", async () => {
    h.getWaSettingsById.mockImplementation(async (id: number) => (id === 2 ? settings({ enabled: false }) : null));
    expect((await sendWhatsAppTextToChatIdPos("1@c.us", "hi")).error).toBe("WhatsApp sending is disabled");
    expect((await sendWhatsAppFileByUploadPos("1@c.us", Buffer.from("x"), "a.pdf", "")).error).toBe(
      "WhatsApp sending is disabled"
    );
    expect((await sendWhatsAppFileToChatIdPos("1@c.us", Buffer.from("x"), "a.pdf", "")).error).toBe(
      "WhatsApp sending is disabled"
    );
    h.getWaSettingsById.mockResolvedValue(null);
    expect((await sendWhatsAppFileByUploadPos("1@c.us", Buffer.from("x"), "a.pdf", "")).error).toBe(
      "WhatsApp credentials not configured"
    );
    expect((await sendWhatsAppFileToChatIdPos("1@c.us", Buffer.from("x"), "a.pdf", "")).error).toBe(
      "WhatsApp credentials not configured"
    );
    expect(h.uploadGreenApiWithAuthFallback).not.toHaveBeenCalled();
  });
});

describe("file upload helper outcomes", () => {
  it("returns sent, failed and uncertain outcomes for the main instance", async () => {
    h.getWaSettings.mockResolvedValue(null);
    expect((await sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.bin", "")).error).toBe(
      "WhatsApp credentials not configured"
    );
    h.getWaSettings.mockResolvedValue(settings({ enabled: false }));
    expect((await sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.bin", "")).error).toBe(
      "WhatsApp sending is disabled"
    );
    h.getWaSettings.mockResolvedValue(settings());
    h.uploadGreenApiWithAuthFallback.mockRejectedValueOnce(new Error(""));
    expect(await sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.bin", "cap")).toEqual({
      success: false,
      error: "Green API request outcome is uncertain",
      deliveryOutcome: "uncertain",
    });
    h.uploadGreenApiWithAuthFallback.mockResolvedValueOnce(fail(413, "too big"));
    expect(await sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.bin", "")).toEqual({
      success: false,
      error: "Green API 413: too big",
      deliveryOutcome: "failed",
    });
    h.uploadGreenApiWithAuthFallback.mockResolvedValueOnce(new Response("{", { status: 200 }));
    expect(await sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.bin", "")).toEqual({
      success: true,
      deliveryOutcome: "sent",
    });
  });

  it("uploads through the POS instance", async () => {
    h.getWaSettingsById.mockImplementation(async (id: number) => (id === 2 ? settings() : null));
    h.uploadGreenApiWithAuthFallback.mockResolvedValue(ok());
    expect(await sendWhatsAppFileByUploadPos("1@c.us", Buffer.from("x"), "a.pdf", "cap")).toMatchObject({
      success: true,
    });
    expect(await sendWhatsAppFileToChatIdPos("1@c.us", Buffer.from("x"), "a.pdf", "cap")).toMatchObject({
      success: true,
    });
  });
});

describe("broadcast senders", () => {
  it.each([
    ["text", () => sendWhatsAppText("hello")],
    ["file", () => sendWhatsAppFile(Buffer.from("x"), "r.xlsx", "cap")],
  ] as const)("%s refuses missing credentials, disabled sending and empty recipients", async (_n, send) => {
    h.getWaSettings.mockResolvedValueOnce(null);
    expect((await send()).errors).toEqual(["WhatsApp credentials not configured"]);
    h.getWaSettings.mockResolvedValueOnce(settings({ enabled: false }));
    expect((await send()).errors).toEqual(["WhatsApp sending is disabled"]);
    h.getWaSettings.mockResolvedValueOnce(settings());
    h.getActiveRecipients.mockResolvedValueOnce([]);
    expect(await send()).toEqual({ success: false, sent: 0, failed: 0, errors: ["No active WhatsApp recipients"] });
  });

  it("counts per-recipient text successes and failures", async () => {
    h.getWaSettings.mockResolvedValue(settings());
    h.getActiveRecipients.mockResolvedValue([{ chatId: "1@c.us" }, { chatId: "2@c.us" }, { chatId: "3@c.us" }]);
    h.fetchGreenApiWithAuthFallback
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(fail(500, "down"))
      .mockRejectedValueOnce(new Error("socket"));
    expect(await sendWhatsAppText("hello")).toEqual({
      success: true,
      sent: 1,
      failed: 2,
      errors: ["Green API 500: down", "socket"],
    });
    h.fetchGreenApiWithAuthFallback.mockResolvedValue(fail(400, "bad"));
    expect((await sendWhatsAppText("hello")).success).toBe(false);
  });

  it("counts per-recipient file successes and failures", async () => {
    h.getWaSettings.mockResolvedValue(settings());
    h.getActiveRecipients.mockResolvedValue([{ chatId: "1@c.us" }, { chatId: "2@c.us" }]);
    h.uploadGreenApiWithAuthFallback.mockResolvedValueOnce(ok()).mockResolvedValueOnce(fail(400, "bad"));
    expect(await sendWhatsAppFile(Buffer.from("x"), "r.xlsx", "")).toEqual({
      success: true,
      sent: 1,
      failed: 1,
      errors: ["Green API 400: bad"],
    });
  });
});
