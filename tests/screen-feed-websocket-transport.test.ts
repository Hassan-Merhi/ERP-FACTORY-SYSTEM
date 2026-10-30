/**
 * The screen-feed WebSocket relay. An ERP tab binds as the producer of its own
 * feed; a support controller binds as a viewer after the tenant gate allows
 * it. Frames are relayed byte for byte to the viewers of that exact feed, the
 * last frame is replayed to a new viewer, producers learn whether anyone is
 * watching, and malformed, oversized or unbound frames are refused.
 */
const gate = vi.hoisted(() => ({ allowed: true, message: "denied" }));
vi.mock("../server/services/screenFeedTenantGate", () => ({
  assertScreenFeedTenantAccess: async () => ({ allowed: gate.allowed, message: gate.message }),
}));

import type { WebSocket } from "ws";
import { encodeRemoteSupportBinaryPacket, REMOTE_SUPPORT_MAX_FRAME_BYTES } from "@shared/remoteSupportTransport";
import {
  cleanupExpiredScreenFeedWebSocketFrames,
  cleanupScreenFeedWebSocket,
  handleScreenFeedWebSocketMessage,
  screenFeedSocketKey,
} from "../server/services/screenFeedWebSocketTransport";
import {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
} from "../server/services/remoteControlSessionService";
import { updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";

type Message = Record<string, unknown>;
function fakeSocket(open = true) {
  const json: Message[] = [];
  const binary: Buffer[] = [];
  const socket = {
    readyState: open ? 1 : 3,
    send: vi.fn((payload: string | Buffer, options?: { binary?: boolean }) => {
      if (options?.binary) binary.push(payload as Buffer);
      else json.push(JSON.parse(payload as string));
    }),
  } as unknown as WebSocket;
  return { socket, json, binary };
}

const employee = { userId: "22", username: "employee", role: "Staff", companyId: 7 };
const support = { userId: "1", username: "support", role: "Admin", companyId: 7 };

const text = (socket: WebSocket, context: typeof employee, message: unknown) =>
  handleScreenFeedWebSocketMessage(socket, context, Buffer.from(JSON.stringify(message)), false);
const frame = (tabId = "tab-1", capturedAt = new Date().toISOString(), bytes = 4) =>
  Buffer.from(
    encodeRemoteSupportBinaryPacket(
      { type: "screen-feed-frame", version: 1, tabId, capturedAt, metadata: { capture: { durationMs: 12 } } },
      new Uint8Array(bytes).fill(7)
    )
  );
const last = (messages: Message[]) => messages[messages.length - 1];

let tracked: WebSocket[] = [];
function socketFor(open = true) {
  const s = fakeSocket(open);
  tracked.push(s.socket);
  return s;
}

beforeEach(() => {
  resetRemoteControlSessionStateForTests();
  updateRemoteSupportFlags(
    {
      screenFeedEnabled: true,
      fastScreenFeed: true,
      remoteControl: true,
      keyboardControl: true,
      sensitiveActionProtection: true,
    },
    "screen-feed-test"
  );
  registerRemoteControlTab({ userId: "22", username: "employee", tabId: "tab-1", companyId: 7, route: "/sales" });
  gate.allowed = true;
});

afterEach(() => {
  for (const socket of tracked) cleanupScreenFeedWebSocket(socket);
  tracked = [];
  cleanupExpiredScreenFeedWebSocketFrames(Number.MAX_SAFE_INTEGER);
});

describe("producers", () => {
  it("binds a tab and tells it nobody is watching yet", async () => {
    const tab = socketFor();

    expect(await text(tab.socket, employee, { type: "screen-feed:producer-bind", tabId: "tab-1" })).toBe(true);

    expect(tab.json).toEqual([
      { type: "screen-feed:producer-bound", tabId: "tab-1" },
      { type: "screen-feed:status", watched: false, fast: false },
    ]);
  });

  it("refuses a missing tab id and a tab registered to another company", async () => {
    const tab = socketFor();

    expect(await text(tab.socket, employee, { type: "screen-feed:producer-bind", tabId: " " })).toBe(false);
    expect(last(tab.json)).toMatchObject({ code: "INVALID_TAB_ID" });
    expect(
      await text(tab.socket, { ...employee, companyId: 9 }, { type: "screen-feed:producer-bind", tabId: "tab-1" })
    ).toBe(false);
    expect(last(tab.json)).toMatchObject({ code: "TAB_COMPANY_MISMATCH" });
  });
});

describe("viewers", () => {
  async function producer() {
    const tab = socketFor();
    await text(tab.socket, employee, { type: "screen-feed:producer-bind", tabId: "tab-1" });
    return tab;
  }

  it("binds a support viewer, tells the producer it is watched, and replays the last frame", async () => {
    const tab = await producer();
    const packet = frame();
    await handleScreenFeedWebSocketMessage(tab.socket, employee, packet, true);
    const viewer = socketFor();

    expect(await text(viewer.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" })).toBe(
      true
    );

    expect(viewer.json).toEqual([{ type: "screen-feed:viewer-bound", userId: "22", tabId: "tab-1" }]);
    expect(viewer.binary).toEqual([packet]);
    expect(last(tab.json)).toEqual({ type: "screen-feed:status", watched: true, fast: true });
  });

  it.each([
    ["a non-support role", { ...support, role: "Staff" }, { userId: "22", tabId: "tab-1" }, "VIEW_NOT_AUTHORIZED"],
    ["a missing target", support, { userId: "", tabId: "tab-1" }, "INVALID_WATCH_TARGET"],
    ["an unknown tab", support, { userId: "22", tabId: "tab-9" }, "TARGET_TAB_UNAVAILABLE"],
    ["another company", { ...support, companyId: 9 }, { userId: "22", tabId: "tab-1" }, "TARGET_TAB_UNAVAILABLE"],
  ])("refuses a viewer with %s", async (_label, context, target, code) => {
    const viewer = socketFor();

    expect(await text(viewer.socket, context, { type: "screen-feed:viewer-bind", ...target })).toBe(false);
    expect(last(viewer.json)).toMatchObject({ code });
  });

  it("lets a developer watch a tab in any company, but not past the tenant gate", async () => {
    const viewer = socketFor();
    await text(
      viewer.socket,
      { ...support, role: "Developer", companyId: 9 },
      { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" }
    );
    expect(last(viewer.json)).toMatchObject({ type: "screen-feed:viewer-bound" });

    gate.allowed = false;
    gate.message = "Tenant blocked";
    await text(viewer.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" });
    expect(last(viewer.json)).toMatchObject({ code: "TENANT_ACCESS_DENIED", message: "Tenant blocked" });
  });

  it("stops telling the producer it is watched once the viewer leaves", async () => {
    const tab = await producer();
    const viewer = socketFor();
    await text(viewer.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" });

    cleanupScreenFeedWebSocket(viewer.socket);

    expect(last(tab.json)).toEqual({ type: "screen-feed:status", watched: false, fast: false });
  });
});

describe("frames and producer messages", () => {
  async function wired() {
    const tab = socketFor();
    await text(tab.socket, employee, { type: "screen-feed:producer-bind", tabId: "tab-1" });
    const viewer = socketFor();
    await text(viewer.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" });
    return { tab, viewer };
  }

  it("relays each frame byte for byte to the viewers of that feed only", async () => {
    const { tab, viewer } = await wired();
    registerRemoteControlTab({ userId: "22", username: "employee", tabId: "tab-2", companyId: 7, route: "/stock" });
    const otherViewer = socketFor();
    await text(otherViewer.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-2" });
    const packet = frame();

    await handleScreenFeedWebSocketMessage(tab.socket, employee, packet, true);

    expect(viewer.binary).toEqual([packet]);
    expect(otherViewer.binary).toEqual([]);
  });

  it.each([
    ["an unbound tab", () => frame("tab-2"), "TAB_NOT_BOUND"],
    ["a malformed packet", () => Buffer.from([9, 9, 9]), "INVALID_FRAME_PACKET"],
    ["an oversized packet", () => Buffer.alloc(REMOTE_SUPPORT_MAX_FRAME_BYTES + 24 * 1024 + 6), "FRAME_TOO_LARGE"],
  ])("refuses %s", async (_label, packet, code) => {
    const { tab, viewer } = await wired();

    await handleScreenFeedWebSocketMessage(tab.socket, employee, packet(), true);

    expect(last(tab.json)).toMatchObject({ type: "screen-feed:error", code });
    expect(viewer.binary).toEqual([]);
  });

  it("drops frames while the screen feed is switched off", async () => {
    const { tab, viewer } = await wired();
    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-test");

    expect(await handleScreenFeedWebSocketMessage(tab.socket, employee, frame(), true)).toBe(true);

    expect(viewer.binary).toEqual([]);
  });

  it("forwards cursor and failure messages from the bound producer only", async () => {
    const { tab, viewer } = await wired();
    const stranger = socketFor();

    expect(await text(tab.socket, employee, { type: "screen-feed:cursor", tabId: "tab-1", cursor: { x: 0.5 } })).toBe(
      true
    );
    expect(last(viewer.json)).toEqual({ type: "screen-feed:cursor", tabId: "tab-1", userId: "22", cursor: { x: 0.5 } });
    expect(await text(tab.socket, employee, { type: "screen-feed:failure", tabId: "tab-1" })).toBe(true);
    expect(await text(tab.socket, employee, { type: "screen-feed:other", tabId: "tab-1" })).toBe(false);
    expect(await text(stranger.socket, employee, { type: "screen-feed:cursor", tabId: "tab-1" })).toBe(false);
  });

  it("accepts paint acknowledgements only from the bound viewer", async () => {
    const { viewer } = await wired();
    const capturedAt = new Date().toISOString();

    expect(
      await text(viewer.socket, support, {
        type: "screen-feed:viewer-rendered",
        userId: "22",
        tabId: "tab-1",
        capturedAt,
        viewerRenderedAt: Date.now(),
      })
    ).toBe(true);
    expect(
      await text(viewer.socket, employee, { type: "screen-feed:viewer-rendered", userId: "22", tabId: "tab-1" })
    ).toBe(true);
    expect(await text(viewer.socket, support, { type: "screen-feed:viewer-rendered", userId: "", tabId: "" })).toBe(
      true
    );
  });

  it("ignores non-JSON, non-object and non-screen-feed messages", async () => {
    const tab = socketFor();

    expect(await handleScreenFeedWebSocketMessage(tab.socket, employee, Buffer.from("{"), false)).toBe(false);
    expect(await handleScreenFeedWebSocketMessage(tab.socket, employee, Buffer.from("[1]"), false)).toBe(false);
    expect(await text(tab.socket, employee, { type: "remote-control:bind" })).toBe(false);
  });

  it("forgets the last frame once it is older than two minutes, and never sends to a closed socket", async () => {
    const { tab } = await wired();
    await handleScreenFeedWebSocketMessage(tab.socket, employee, frame(), true);
    cleanupExpiredScreenFeedWebSocketFrames(Date.now() + 3 * 60 * 1000);
    const late = socketFor();

    await text(late.socket, support, { type: "screen-feed:viewer-bind", userId: "22", tabId: "tab-1" });
    expect(late.binary).toEqual([]);

    const closed = socketFor(false);
    await text(closed.socket, employee, { type: "screen-feed:producer-bind", tabId: "tab-1" });
    expect(closed.socket.send).not.toHaveBeenCalled();
  });
});

it("keys a feed by user and tab", () => {
  expect(screenFeedSocketKey(" 22 ", " tab-1 ")).toBe("22\u0000tab-1");
});
