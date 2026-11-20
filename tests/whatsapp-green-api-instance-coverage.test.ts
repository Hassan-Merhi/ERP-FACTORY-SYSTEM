import { beforeEach, describe, expect, it, vi } from "vitest";

const transport = vi.hoisted(() => ({
  fetchGreenApiReadOnly: vi.fn(),
  fetchGreenApiWithAuthFallback: vi.fn(),
  authorized: vi.fn(),
}));

vi.mock("../server/services/whatsappGreenApiTransport", () => ({
  fetchGreenApiReadOnly: transport.fetchGreenApiReadOnly,
  fetchGreenApiWithAuthFallback: transport.fetchGreenApiWithAuthFallback,
}));
vi.mock("../server/services/security/stockTransferOrderWaWebhookAuthentication", () => ({
  authorizedStockTransferOrderWaWebhook: transport.authorized,
}));

import {
  fetchGreenApiChats,
  fetchStrictGreenMainChats,
  getGreenInstanceState,
  getStrictGreenMainInstanceState,
  getStrictGreenMainWebhookReadiness,
} from "../server/services/whatsappGreenApiInstance";

const json = (body: unknown, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const ID = "1101234567";
const TOKEN = "abcdef0123456789abcdef0123456789abcdef0123456789ab";

beforeEach(() => {
  vi.clearAllMocks();
  transport.authorized.mockReturnValue(false);
});

describe("getGreenInstanceState", () => {
  it("returns a known provider state", async () => {
    transport.fetchGreenApiWithAuthFallback.mockResolvedValue(json({ stateInstance: "yellowCard" }));
    expect(await getGreenInstanceState(ID, TOKEN)).toBe("yellowCard");
    expect(transport.fetchGreenApiWithAuthFallback).toHaveBeenCalledWith(
      { instanceId: ID, apiToken: TOKEN },
      "getStateInstance",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("maps HTTP errors, bad JSON, missing and unknown states, and network failures to unknown", async () => {
    transport.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(json({}, 500));
    expect(await getGreenInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(json("not json"));
    expect(await getGreenInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(json({ stateInstance: "melting" }));
    expect(await getGreenInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiWithAuthFallback.mockRejectedValueOnce(new Error("timeout"));
    expect(await getGreenInstanceState(ID, TOKEN)).toBe("unknown");
  });
});

describe("getStrictGreenMainInstanceState", () => {
  it("refuses blank credentials without calling the provider", async () => {
    expect(await getStrictGreenMainInstanceState("", TOKEN)).toBe("invalidCredentials");
    expect(await getStrictGreenMainInstanceState(ID, "  ")).toBe("invalidCredentials");
    expect(transport.fetchGreenApiReadOnly).not.toHaveBeenCalled();
  });

  it("maps provider responses strictly", async () => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 401));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("invalidCredentials");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 403));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("invalidCredentials");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 502));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json("{broken"));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({ stateInstance: 7 }));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({ stateInstance: "other" }));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("unknown");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({ stateInstance: "authorized" }));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("authorized");
    transport.fetchGreenApiReadOnly.mockRejectedValueOnce(new Error("socket hang up"));
    expect(await getStrictGreenMainInstanceState(ID, TOKEN)).toBe("unknown");
    expect(transport.fetchGreenApiWithAuthFallback).not.toHaveBeenCalled();
  });
});

describe("getStrictGreenMainWebhookReadiness", () => {
  it("throws on HTTP failure and on non-object settings", async () => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 503));
    await expect(getStrictGreenMainWebhookReadiness(ID, TOKEN)).rejects.toThrow("HTTP 503");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json([1]));
    await expect(getStrictGreenMainWebhookReadiness(ID, TOKEN)).rejects.toThrow("invalid main instance settings");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json("nope"));
    await expect(getStrictGreenMainWebhookReadiness(ID, TOKEN)).rejects.toThrow("invalid main instance settings");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json(5));
    await expect(getStrictGreenMainWebhookReadiness(ID, TOKEN)).rejects.toThrow("invalid main instance settings");
  });

  it("reports a fully matching webhook without exposing the bearer", async () => {
    transport.authorized.mockReturnValue(true);
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(
      json({
        webhookUrl: " https://hmdinternationalgroup.com/api/stock-transfer-order/wa-approval/webhook/ ",
        webhookUrlToken: "bearer-secret",
        incomingWebhook: "yes",
        outgoingMessageWebhook: "yes",
        wid: "971501234567@c.us",
      })
    );
    const result = await getStrictGreenMainWebhookReadiness(ID, TOKEN);
    expect(result).toEqual({
      incomingWebhookEnabled: true,
      outgoingPhoneWebhookEnabled: true,
      webhookUrlConfigured: true,
      webhookEndpointMatches: true,
      webhookTokenMatches: true,
      webhookHost: "hmdinternationalgroup.com",
      mainAccountChatId: "971501234567@c.us",
    });
    expect(transport.authorized).toHaveBeenCalledWith("bearer-secret");
  });

  it.each([
    ["http://hmdinternationalgroup.com/api/stock-transfer-order/wa-approval/webhook", false, null],
    ["https://user:pw@hmdinternationalgroup.com/api/stock-transfer-order/wa-approval/webhook", false, null],
    ["https://evil.example/api/stock-transfer-order/wa-approval/webhook", false, "evil.example"],
    ["https://hmdinternationalgroup.com/other", false, "hmdinternationalgroup.com"],
    [
      "https://hmdinternationalgroup.com/api/stock-transfer-order/wa-approval/webhook?x=1",
      false,
      "hmdinternationalgroup.com",
    ],
    [
      "https://hmdinternationalgroup.com/api/stock-transfer-order/wa-approval/webhook#h",
      false,
      "hmdinternationalgroup.com",
    ],
    [
      "https://hmdinternationalgroup.com:8443/api/stock-transfer-order/wa-approval/webhook",
      false,
      "hmdinternationalgroup.com",
    ],
    ["not a url", false, null],
  ])("rejects webhook URL %s", async (webhookUrl, matches, host) => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(
      json({ webhookUrl, webhookUrlToken: 9, incomingWebhook: "no", wid: "0123@c.us" })
    );
    const result = await getStrictGreenMainWebhookReadiness(ID, TOKEN);
    expect(result).toMatchObject({
      webhookUrlConfigured: true,
      webhookEndpointMatches: matches,
      webhookHost: host,
      incomingWebhookEnabled: false,
      outgoingPhoneWebhookEnabled: false,
      webhookTokenMatches: false,
      mainAccountChatId: null,
    });
    expect(transport.authorized).toHaveBeenCalledWith("");
  });

  it("reports an unconfigured webhook when the URL is missing or not a string", async () => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({ webhookUrl: 12, wid: 5 }));
    expect(await getStrictGreenMainWebhookReadiness(ID, TOKEN)).toMatchObject({
      webhookUrlConfigured: false,
      webhookEndpointMatches: false,
      webhookHost: null,
      mainAccountChatId: null,
    });
  });
});

describe("fetchStrictGreenMainChats", () => {
  it("names credential rejection separately from other failures", async () => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 401));
    await expect(fetchStrictGreenMainChats(ID, TOKEN)).rejects.toThrow("credentials are rejected");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 403));
    await expect(fetchStrictGreenMainChats(ID, TOKEN)).rejects.toThrow("credentials are rejected");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({}, 500));
    await expect(fetchStrictGreenMainChats(ID, TOKEN)).rejects.toThrow("Unable to verify the approval group");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json({ chats: [] }));
    await expect(fetchStrictGreenMainChats(ID, TOKEN)).rejects.toThrow("invalid chat list");
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(json("[oops"));
    await expect(fetchStrictGreenMainChats(ID, TOKEN)).rejects.toThrow("invalid chat list");
  });

  it("keeps only chats with string ids and normalizes names and types", async () => {
    transport.fetchGreenApiReadOnly.mockResolvedValueOnce(
      json([
        null,
        "x",
        { id: 4 },
        { id: "123@g.us", name: "Approvals", type: "contact" },
        { id: "555@c.us", name: "", type: "contact" },
        { id: "666@c.us", type: 3 },
      ])
    );
    expect(await fetchStrictGreenMainChats(ID, TOKEN)).toEqual([
      { id: "123@g.us", name: "Approvals", type: "group" },
      { id: "555@c.us", name: "555@c.us", type: "contact" },
      { id: "666@c.us", name: "666@c.us", type: "contact" },
    ]);
  });
});

describe("fetchGreenApiChats", () => {
  it("includes the provider body in errors", async () => {
    transport.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(new Response("quota exceeded", { status: 429 }));
    await expect(fetchGreenApiChats(ID, TOKEN)).rejects.toThrow("Green API getChats error 429: quota exceeded");
  });

  it("maps chats with fallback names and types", async () => {
    transport.fetchGreenApiWithAuthFallback.mockResolvedValueOnce(
      json([null, {}, { id: "9@g.us" }, { id: "8@c.us", name: "Ali", type: "contact" }, { id: "7@c.us" }])
    );
    expect(await fetchGreenApiChats(ID, TOKEN)).toEqual([
      { id: "9@g.us", name: "9@g.us", type: "group" },
      { id: "8@c.us", name: "Ali", type: "contact" },
      { id: "7@c.us", name: "7@c.us", type: "contact" },
    ]);
  });
});
