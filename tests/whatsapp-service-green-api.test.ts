import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type SettingsRow = {
  instance_id: string;
  api_token: string;
  enabled: boolean | null;
  monthly_auto_send?: boolean | null;
  daily_auto_send?: boolean | null;
  daily_recipient_id?: number | null;
};

type HttpsCall = { url: URL; options: Record<string, unknown>; body?: Buffer };
type HttpsReply = { status?: number; body?: string } | { error: Error & { code?: string } } | "timeout" | "hang";

const deps = vi.hoisted(() => ({
  settings: new Map<number, unknown>(),
  recipients: [] as unknown[],
  queries: [] as { sql: string; params?: unknown[] }[],
  extraRows: [] as unknown[],
  httpsCalls: [] as unknown[],
  httpsReplies: [] as unknown[],
}));

vi.mock("../server/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/db")>()),
  pool: {
    query: async (sql: string, params?: unknown[]) => {
      deps.queries.push({ sql, params });
      if (sql.includes("FROM whatsapp_settings WHERE id = $1")) {
        const row = deps.settings.get(Number(params?.[0]));
        return { rows: row ? [row] : [] };
      }
      if (sql.includes("FROM whatsapp_recipients")) return { rows: deps.recipients };
      if (sql.startsWith("UPDATE")) return { rows: [] };
      return { rows: deps.extraRows };
    },
  },
}));

vi.mock("node:https", () => ({
  request: (
    url: URL,
    options: Record<string, unknown>,
    onResponse: (res: EventEmitter & { statusCode?: number }) => void
  ) => {
    const call: HttpsCall = { url, options };
    deps.httpsCalls.push(call);
    const reply = (deps.httpsReplies.shift() ?? { status: 200, body: "{}" }) as HttpsReply;
    const req = new EventEmitter() as EventEmitter & {
      end: (body?: Buffer) => void;
      destroy: (error: Error) => void;
    };
    let finished = false;
    req.destroy = (error: Error) => {
      if (finished) return;
      finished = true;
      req.emit("error", error);
      req.emit("close");
    };
    req.end = (body?: Buffer) => {
      call.body = body;
      setImmediate(() => {
        if (finished) return;
        if (reply === "hang") return;
        if (reply === "timeout") {
          req.emit("timeout");
          return;
        }
        if ("error" in reply) {
          finished = true;
          req.emit("error", reply.error);
          return;
        }
        const res = new EventEmitter() as EventEmitter & { statusCode?: number };
        res.statusCode = reply.status;
        onResponse(res);
        if (reply.body) res.emit("data", Buffer.from(reply.body));
        finished = true;
        res.emit("end");
        req.emit("close");
      });
    };
    return req;
  },
}));

import * as wa from "../server/services/whatsappService";
import { logger } from "../server/lib/logger";

const fetchMock = vi.fn<(url: string, init: RequestInit) => Promise<Response>>();

function settingsRow(over: Partial<SettingsRow> = {}): SettingsRow {
  return {
    instance_id: "1101",
    api_token: "tok-main",
    enabled: true,
    monthly_auto_send: true,
    daily_auto_send: false,
    daily_recipient_id: 4,
    ...over,
  };
}

function https(...replies: HttpsReply[]) {
  deps.httpsReplies.push(...replies);
}

function httpsCalls(): HttpsCall[] {
  return deps.httpsCalls as HttpsCall[];
}

function fetchUrls(): string[] {
  return fetchMock.mock.calls.map(([url]) => url);
}

beforeEach(() => {
  deps.settings.clear();
  deps.recipients = [];
  deps.queries = [];
  deps.extraRows = [];
  deps.httpsCalls = [];
  deps.httpsReplies = [];
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
  vi.spyOn(logger, "info").mockImplementation(() => logger);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("settings reads", () => {
  it("normalises plain numbers and keeps formatted chat ids", () => {
    expect(wa.normaliseChatId(" +243 812-345 ")).toBe("243812345@c.us");
    expect(wa.normaliseChatId(" 1203630@g.us ")).toBe("1203630@g.us");
    expect(wa.normaliseChatId("243-1@c.us")).toBe("243-1@c.us");
  });

  it("strips pasted whitespace and zero-width characters and defaults missing flags", async () => {
    deps.settings.set(1, {
      instance_id: " 11​01\n",
      api_token: "﻿tok main ",
      enabled: null,
      monthly_auto_send: null,
      daily_auto_send: null,
      daily_recipient_id: null,
    });
    await expect(wa.getWaSettings()).resolves.toEqual({
      instanceId: "1101",
      apiToken: "tokmain",
      enabled: false,
      monthlyAutoSend: false,
      dailyAutoSend: false,
      dailyRecipientId: null,
    });
    await expect(wa.getWaSettingsById(9)).resolves.toBeNull();
  });

  it("maps active recipients", async () => {
    deps.recipients = [{ id: 3, chat_id: "1@c.us", name: "Ops", is_group: false, active: true }];
    await expect(wa.getActiveRecipients()).resolves.toEqual([
      { id: 3, chatId: "1@c.us", name: "Ops", isGroup: false, active: true },
    ]);
  });

  it("prefers the POS instance and otherwise force-enables the main instance", async () => {
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos", enabled: false }));
    deps.settings.set(1, settingsRow({ enabled: false }));
    await expect(wa.getPosWaSettings()).resolves.toMatchObject({ instanceId: "2202", enabled: false });

    deps.settings.set(2, settingsRow({ instance_id: "", api_token: "tok-pos" }));
    await expect(wa.getPosWaSettings()).resolves.toMatchObject({ instanceId: "1101", enabled: true });

    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "" }));
    await expect(wa.getPosWaSettings()).resolves.toMatchObject({ instanceId: "1101", enabled: true });

    deps.settings.set(1, settingsRow({ api_token: "" }));
    await expect(wa.getPosWaSettings()).resolves.toBeNull();
  });
});

describe("Green API read requests", () => {
  it("reads the instance state over IPv4 and rejects unknown states", async () => {
    https({ status: 200, body: JSON.stringify({ stateInstance: "authorized" }) });
    await expect(wa.getGreenInstanceState(" 1101 ", "tok")).resolves.toBe("authorized");
    expect(String(httpsCalls()[0].url)).toBe("https://api.greenapi.com/waInstance1101/getStateInstance/tok");
    expect(httpsCalls()[0].options).toMatchObject({ method: "GET", family: 4 });

    https({ status: 200, body: JSON.stringify({ stateInstance: "blocked" }) });
    await expect(wa.getGreenInstanceState("1101", "tok")).resolves.toBe("unknown");

    https({ status: 200, body: "not json" });
    await expect(wa.getGreenInstanceState("1101", "tok")).resolves.toBe("unknown");

    https({ status: 500, body: "boom" });
    await expect(wa.getGreenInstanceState("1101", "tok")).resolves.toBe("unknown");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries a failed read once and then reports the network code", async () => {
    https({ error: Object.assign(new Error("reset"), { code: "ECONNRESET" }) }, "timeout");
    await expect(wa.getGreenInstanceState("1101", "tok")).resolves.toBe("unknown");
    expect(httpsCalls()).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledWith("[WhatsApp] Green API read request failed", {
      method: "getStateInstance",
      attempt: 1,
      code: "ECONNRESET",
    });
    expect(logger.warn).toHaveBeenCalledWith("[WhatsApp] Green API read request failed", {
      method: "getStateInstance",
      attempt: 2,
      code: "ETIMEDOUT",
    });
    expect(logger.warn).toHaveBeenCalledWith("[WhatsApp] Green API instance status unavailable", {
      error: "Green API connection failed (ETIMEDOUT). Check provider and outbound networking.",
    });
  });

  it("uses a nested cause code and falls back to NETWORK_ERROR", async () => {
    https(
      { error: Object.assign(new Error("dns"), { cause: { code: "ENOTFOUND" } }) },
      { error: new Error("no code") }
    );
    await expect(wa.fetchGreenApiChats("1101", "tok")).rejects.toThrow(
      "Green API connection failed (NETWORK_ERROR). Check provider and outbound networking."
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "[WhatsApp] Green API read request failed",
      expect.objectContaining({ attempt: 1, code: "ENOTFOUND" })
    );
  });

  it("stops retrying once the caller's signal aborts", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      https("hang", "hang");
      const pending = wa.getGreenInstanceState("1101", "tok");
      // getGreenInstanceState aborts after eight seconds.
      await vi.advanceTimersByTimeAsync(8_001);
      await expect(pending).resolves.toBe("unknown");
      expect(httpsCalls()).toHaveLength(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "[WhatsApp] Green API read request failed",
        expect.objectContaining({ attempt: 1, code: "ABORT_ERR" })
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists chats, labelling groups and falling back to the id as name", async () => {
    https({
      status: 200,
      body: JSON.stringify([
        { id: "1203@g.us", name: "Team" },
        { id: "243@c.us" },
        { id: "99@c.us", name: "Bot", type: "bot" },
        { name: "no id" },
        null,
      ]),
    });
    await expect(wa.fetchGreenApiChats("1101", "tok")).resolves.toEqual([
      { id: "1203@g.us", name: "Team", type: "group" },
      { id: "243@c.us", name: "243@c.us", type: "contact" },
      { id: "99@c.us", name: "Bot", type: "bot" },
    ]);

    https({ status: 403, body: "denied" });
    await expect(wa.fetchGreenApiChats("1101", "tok")).rejects.toThrow("Green API getChats error 403: denied");
  });

  it("retries a 401 read with the other enabled instance", async () => {
    deps.settings.set(1, settingsRow());
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    https({ status: 401, body: "bad" }, { status: 200, body: "[]" });
    await expect(wa.fetchGreenApiChats("1101", "tok-main")).resolves.toEqual([]);
    expect(String(httpsCalls()[1].url)).toBe("https://api.greenapi.com/waInstance2202/getChats/tok-pos");
    expect(logger.warn).toHaveBeenCalledWith("[WhatsApp] Green API backup credentials accepted after primary 401", {
      primaryInstanceId: "1101",
      fallbackInstanceId: "2202",
      method: "getChats",
    });
  });

  it("treats a rotated token on the same instance as a usable backup", async () => {
    deps.settings.set(1, settingsRow({ api_token: "tok-new" }));
    https({ status: 401, body: "bad" }, { status: 200, body: "[]" });
    await expect(wa.fetchGreenApiChats("1101", "tok-old")).resolves.toEqual([]);
    expect(String(httpsCalls()[1].url)).toBe("https://api.greenapi.com/waInstance1101/getChats/tok-new");
  });

  it("returns the primary 401 when no other enabled instance exists", async () => {
    deps.settings.set(1, settingsRow());
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos", enabled: false }));
    https({ status: 401, body: "bad" });
    await expect(wa.fetchGreenApiChats("1101", "tok-main")).rejects.toThrow("getChats error 401: bad");
    expect(httpsCalls()).toHaveLength(1);
  });
});

describe("text sends", () => {
  it("refuses to send without credentials or while disabled", async () => {
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "hi")).resolves.toEqual({
      success: false,
      error: "WhatsApp credentials not configured",
    });
    deps.settings.set(1, settingsRow({ enabled: false }));
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "hi")).resolves.toEqual({
      success: false,
      error: "WhatsApp sending is disabled",
    });
    await expect(wa.sendWhatsAppText("hi")).resolves.toMatchObject({ errors: ["WhatsApp sending is disabled"] });
    deps.settings.delete(1);
    await expect(wa.sendWhatsAppText("hi")).resolves.toMatchObject({
      errors: ["WhatsApp credentials not configured"],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts a message with a request timeout and reports provider errors", async () => {
    deps.settings.set(1, settingsRow());
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "hello")).resolves.toEqual({ success: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.greenapi.com/waInstance1101/sendMessage/tok-main");
    expect(init).toMatchObject({ method: "POST", body: JSON.stringify({ chatId: "1@c.us", message: "hello" }) });
    expect(init.signal).toBeInstanceOf(AbortSignal);

    fetchMock.mockResolvedValueOnce(new Response("quota", { status: 466 }));
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "hello")).resolves.toEqual({
      success: false,
      error: "Green API 466: quota",
    });
  });

  it("retries a rejected POST once with the backup instance and does not log acceptance on failure", async () => {
    deps.settings.set(1, settingsRow());
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    fetchMock
      .mockResolvedValueOnce(new Response("no", { status: 401 }))
      .mockResolvedValueOnce(new Response("still no", { status: 500 }));
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "x")).resolves.toEqual({
      success: false,
      error: "Green API 500: still no",
    });
    expect(fetchUrls()).toEqual([
      "https://api.greenapi.com/waInstance1101/sendMessage/tok-main",
      "https://api.greenapi.com/waInstance2202/sendMessage/tok-pos",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[WhatsApp] Green API rejected primary credentials; retrying configured backup instance",
      { primaryInstanceId: "1101", fallbackInstanceId: "2202", method: "sendMessage" }
    );
    expect(logger.warn).not.toHaveBeenCalledWith(
      "[WhatsApp] Green API backup credentials accepted after primary 401",
      expect.anything()
    );
    expect(httpsCalls()).toHaveLength(0);
  });

  it("only falls back on a 401, never on other errors", async () => {
    deps.settings.set(1, settingsRow());
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    fetchMock.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(wa.sendWhatsAppTextToChatId("1@c.us", "x")).resolves.toMatchObject({
      error: "Green API 403: forbidden",
    });
    https({ status: 500, body: "err" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", Buffer.from("x"), "a.pdf", "")).resolves.toMatchObject({
      error: "Green API 500: err",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(httpsCalls()).toHaveLength(1);
  });

  it("sends POS text through the POS instance", async () => {
    await expect(wa.sendWhatsAppTextToChatIdPos("1@c.us", "x")).resolves.toEqual({
      success: false,
      error: "WhatsApp credentials not configured",
    });
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos", enabled: false }));
    await expect(wa.sendWhatsAppTextToChatIdPos("1@c.us", "x")).resolves.toEqual({
      success: false,
      error: "WhatsApp sending is disabled",
    });
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    await expect(wa.sendWhatsAppTextToChatIdPos("1@c.us", "x")).resolves.toEqual({ success: true });
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }));
    await expect(wa.sendWhatsAppTextToChatIdPos("1@c.us", "x")).resolves.toEqual({
      success: false,
      error: "Green API 502: down",
    });
    expect(fetchUrls()[0]).toBe("https://api.greenapi.com/waInstance2202/sendMessage/tok-pos");
  });

  it("broadcasts text to every active recipient and counts failures", async () => {
    deps.settings.set(1, settingsRow());
    await expect(wa.sendWhatsAppText("hi")).resolves.toEqual({
      success: false,
      sent: 0,
      failed: 0,
      errors: ["No active WhatsApp recipients"],
    });

    deps.recipients = [
      { id: 1, chat_id: "a@c.us", name: "A", is_group: false, active: true },
      { id: 2, chat_id: "b@c.us", name: "B", is_group: false, active: true },
      { id: 3, chat_id: "c@g.us", name: "C", is_group: true, active: true },
    ];
    fetchMock
      .mockResolvedValueOnce(new Response("{}", { status: 200 }))
      .mockResolvedValueOnce(new Response("bad chat", { status: 400 }))
      .mockRejectedValueOnce(new Error("socket hang up"));
    await expect(wa.sendWhatsAppText("hi")).resolves.toEqual({
      success: true,
      sent: 1,
      failed: 2,
      errors: ["Green API 400: bad chat", "socket hang up"],
    });

    fetchMock.mockResolvedValue(new Response("x", { status: 500 }));
    await expect(wa.sendWhatsAppText("hi")).resolves.toMatchObject({ success: false, sent: 0, failed: 3 });
  });
});

describe("file uploads", () => {
  const pdf = Buffer.from("%PDF-1.4 test");

  it("uploads multipart bodies over IPv4 and reports success", async () => {
    deps.settings.set(1, settingsRow());
    https({ status: 200, body: JSON.stringify({ idMessage: "m1" }) });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "Caption", "application/pdf")).resolves.toEqual({
      success: true,
      deliveryOutcome: "sent",
    });
    const call = httpsCalls()[0];
    expect(String(call.url)).toBe("https://api.greenapi.com/waInstance1101/sendFileByUpload/tok-main");
    expect(call.options).toMatchObject({ method: "POST", family: 4, timeout: 30_000 });
    const headers = call.options.headers as Record<string, unknown>;
    expect(headers["Content-Length"]).toBe(call.body?.length);
    expect(String(headers["content-type"])).toMatch(/^multipart\/form-data; boundary=/);
    const body = call.body?.toString() ?? "";
    expect(body).toContain('name="chatId"');
    expect(body).toContain('name="caption"');
    expect(body).toContain('filename="a.pdf"');
    expect(body).toContain("Content-Type: application/pdf");
    expect(body).toContain("%PDF-1.4 test");
    expect(logger.info).toHaveBeenCalledWith("[WA upload] Green API response", {
      response: { idMessage: "m1" },
      chatId: "1@c.us",
      fileName: "a.pdf",
      size: pdf.length,
    });
  });

  it("omits an empty caption and tolerates a non-JSON success body", async () => {
    deps.settings.set(1, settingsRow());
    https({ status: 200, body: "OK" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.zip", "")).resolves.toMatchObject({ success: true });
    const body = httpsCalls()[0].body?.toString() ?? "";
    expect(body).not.toContain('name="caption"');
    expect(body).toContain("Content-Type: application/octet-stream");
    expect(logger.info).toHaveBeenCalledWith(
      "[WA upload] Green API response",
      expect.objectContaining({ response: {} })
    );
  });

  it("marks a rejected upload failed and a broken connection uncertain", async () => {
    deps.settings.set(1, settingsRow());
    https({ status: 413, body: "too big" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toEqual({
      success: false,
      error: "Green API 413: too big",
      deliveryOutcome: "failed",
    });

    https("timeout");
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toEqual({
      success: false,
      error: "Green API upload connection timed out after 30 seconds",
      deliveryOutcome: "uncertain",
    });

    https({ error: Object.assign(new Error(""), { code: "ECONNRESET" }) });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toMatchObject({
      error: "Green API request outcome is uncertain",
      deliveryOutcome: "uncertain",
    });
    expect(httpsCalls()).toHaveLength(3);
  });

  it("treats a response without a status as a 502", async () => {
    deps.settings.set(1, settingsRow());
    https({ body: "gateway" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toMatchObject({
      error: "Green API 502: gateway",
    });
  });

  it("retries a 401 upload once with the backup instance", async () => {
    deps.settings.set(1, settingsRow());
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    https({ status: 401, body: "no" }, { status: 200, body: "{}" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toMatchObject({ success: true });
    expect(httpsCalls().map((c) => String(c.url))).toEqual([
      "https://api.greenapi.com/waInstance1101/sendFileByUpload/tok-main",
      "https://api.greenapi.com/waInstance2202/sendFileByUpload/tok-pos",
    ]);
    expect(logger.warn).toHaveBeenCalledWith(
      "[WhatsApp] Green API upload credentials rejected; attempting configured backup instance",
      { instanceId: "1101", fallbackInstanceId: "2202" }
    );

    deps.settings.delete(2);
    https({ status: 401, body: "no" });
    await expect(wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", "")).resolves.toMatchObject({
      error: "Green API 401: no",
      deliveryOutcome: "failed",
    });
    expect(httpsCalls()).toHaveLength(3);
  });

  it("guards each file sender on credentials and the enabled flag", async () => {
    const senders = [
      () => wa.sendWhatsAppFileToChatId("1@c.us", pdf, "a.pdf", ""),
      () => wa.sendWhatsAppFileToChatIdPos("1@c.us", pdf, "a.pdf", ""),
      () => wa.sendWhatsAppFileByUploadPos("1@c.us", pdf, "a.pdf", ""),
    ];
    for (const send of senders) {
      await expect(send()).resolves.toEqual({ success: false, error: "WhatsApp credentials not configured" });
    }
    deps.settings.set(1, settingsRow({ enabled: false }));
    await expect(senders[0]()).resolves.toEqual({ success: false, error: "WhatsApp sending is disabled" });
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos", enabled: false }));
    await expect(senders[1]()).resolves.toEqual({ success: false, error: "WhatsApp sending is disabled" });
    await expect(senders[2]()).resolves.toEqual({ success: false, error: "WhatsApp sending is disabled" });
    expect(httpsCalls()).toHaveLength(0);
  });

  it("uploads POS files through the POS instance with a PDF default", async () => {
    deps.settings.set(2, settingsRow({ instance_id: "2202", api_token: "tok-pos" }));
    https({ status: 200, body: "{}" }, { status: 200, body: "{}" });
    await expect(wa.sendWhatsAppFileToChatIdPos("1@c.us", pdf, "r.pdf", "")).resolves.toMatchObject({ success: true });
    await expect(wa.sendWhatsAppFileByUploadPos("1@c.us", pdf, "r.pdf", "")).resolves.toMatchObject({ success: true });
    for (const call of httpsCalls()) {
      expect(String(call.url)).toContain("waInstance2202/sendFileByUpload/tok-pos");
      expect(call.body?.toString()).toContain("Content-Type: application/pdf");
    }
  });

  it("broadcasts a spreadsheet to every recipient and counts failures", async () => {
    await expect(wa.sendWhatsAppFile(pdf, "n.xlsx", "")).resolves.toMatchObject({
      errors: ["WhatsApp credentials not configured"],
    });
    deps.settings.set(1, settingsRow({ enabled: false }));
    await expect(wa.sendWhatsAppFile(pdf, "n.xlsx", "")).resolves.toMatchObject({
      errors: ["WhatsApp sending is disabled"],
    });
    deps.settings.set(1, settingsRow());
    await expect(wa.sendWhatsAppFile(pdf, "n.xlsx", "")).resolves.toEqual({
      success: false,
      sent: 0,
      failed: 0,
      errors: ["No active WhatsApp recipients"],
    });

    deps.recipients = [
      { id: 1, chat_id: "a@c.us", name: "A", is_group: false, active: true },
      { id: 2, chat_id: "b@c.us", name: "B", is_group: false, active: true },
    ];
    https({ status: 200, body: "{}" }, { status: 400, body: "bad" });
    await expect(wa.sendWhatsAppFile(pdf, "n.xlsx", "")).resolves.toEqual({
      success: true,
      sent: 1,
      failed: 1,
      errors: ["Green API 400: bad"],
    });
    expect(httpsCalls()[0].body?.toString()).toContain(
      "Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    https({ status: 500, body: "x" }, { status: 500, body: "y" });
    await expect(wa.sendWhatsAppFile(pdf, "n.xlsx", "")).resolves.toMatchObject({ success: false, sent: 0, failed: 2 });
  });
});

describe("feature settings columns", () => {
  it("reads containers settings with defaults", async () => {
    await expect(wa.getContainersWaSettings()).resolves.toBeNull();
    deps.extraRows = [
      {
        instance_id: " 1101 ",
        api_token: "tok",
        enabled: null,
        containers_wa_group_chat_id: null,
        containers_wa_schedule_enabled: null,
        containers_wa_schedule_hour: null,
        containers_wa_last_sent_at: null,
      },
    ];
    await expect(wa.getContainersWaSettings()).resolves.toEqual({
      instanceId: "1101",
      apiToken: "tok",
      enabled: false,
      groupChatId: "",
      scheduleEnabled: false,
      scheduleHour: 8,
      lastSentAt: null,
    });
    deps.extraRows = [
      {
        instance_id: "1",
        api_token: "t",
        enabled: true,
        containers_wa_group_chat_id: "g@g.us",
        containers_wa_schedule_enabled: true,
        containers_wa_schedule_hour: 0,
        containers_wa_last_sent_at: "2026-10-01T05:00:00Z",
      },
    ];
    await expect(wa.getContainersWaSettings()).resolves.toMatchObject({
      enabled: true,
      groupChatId: "g@g.us",
      scheduleEnabled: true,
      scheduleHour: 0,
      lastSentAt: "2026-10-01T05:00:00.000Z",
    });
  });

  it("reads agent-duty credentials and company transfer groups", async () => {
    await expect(wa.getAgentDutyWaCredentials()).resolves.toBeNull();
    deps.extraRows = [{ instance_id: "1 1", api_token: "t", enabled: null, agent_duty_wa_groups: null }];
    await expect(wa.getAgentDutyWaCredentials()).resolves.toEqual({
      groups: {},
      instanceId: "11",
      apiToken: "t",
      enabled: false,
    });
    deps.extraRows = [{ instance_id: "1", api_token: "t", enabled: true, agent_duty_wa_groups: { north: "n@g.us" } }];
    await expect(wa.getAgentDutyWaCredentials()).resolves.toMatchObject({ groups: { north: "n@g.us" }, enabled: true });

    deps.extraRows = [
      { id: 5, name: "Acme", group_chat_id: "a@g.us" },
      { id: 6, name: "Beta", group_chat_id: null },
    ];
    await expect(wa.getAllCompanyTransferWaSettings()).resolves.toEqual([
      { companyId: 5, companyName: "Acme", groupChatId: "a@g.us" },
      { companyId: 6, companyName: "Beta", groupChatId: "" },
    ]);
  });

  it("writes settings with the expected parameters", async () => {
    await wa.updateContainersWaSettings("g@g.us", true, 9);
    await wa.markContainersWaSent();
    await wa.updateAgentDutyWaGroups({ north: "n@g.us" });
    await wa.setCompanyTransferWaGroupChatId(5, "");
    await wa.setCompanyTransferWaGroupChatId(6, "b@g.us");
    expect(deps.queries.map((q) => q.params)).toEqual([
      ["g@g.us", true, 9],
      undefined,
      [JSON.stringify({ north: "n@g.us" })],
      [null, 5],
      ["b@g.us", 6],
    ]);
    expect(deps.queries[1].sql).toContain("containers_wa_last_sent_at = NOW()");
  });
});
