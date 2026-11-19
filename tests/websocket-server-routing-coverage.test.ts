/**
 * WebSocket server connection lifecycle and message routing, with the same
 * fake `ws` socket/server as phase33f-websocket-auth.test.ts. The remote
 * control, screen-feed and telemetry transports are mocked at the module
 * boundary so the test can see which one each message reaches.
 *
 * Pinned: unauthenticated sockets never reach a transport, malformed JSON
 * falls through to the screen feed (which applies its own checks), telemetry
 * only counts from controller roles with complete identifiers, session
 * lookups that throw, hang or fail close the socket with 1013, identified
 * tabs are excluded from their own broadcasts, and close cleans up.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  server: null as any,
  warn: vi.fn(),
  info: vi.fn(),
  remoteControl: vi.fn(),
  screenFeed: vi.fn(),
  cleanupRemote: vi.fn(),
  cleanupFeed: vi.fn(),
  telemetry: vi.fn(),
}));

vi.mock("../server/lib/observabilityBootstrap", () => ({}));
vi.mock("../server/lib/traceContext", () => ({
  runWithTraceContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../server/lib/logger", () => ({
  logger: { info: h.info, warn: h.warn, error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../server/services/screenFeedWebSocketTransport", () => ({
  cleanupScreenFeedWebSocket: h.cleanupFeed,
  handleScreenFeedWebSocketMessage: h.screenFeed,
  screenFeedSocketKey: (userId: string, tabId: string) => `${userId}:${tabId}`,
}));
vi.mock("../server/services/remoteControlWebSocketTransport", () => ({
  cleanupRemoteControlWebSocket: h.cleanupRemote,
  handleRemoteControlWebSocketMessage: h.remoteControl,
}));
vi.mock("../server/services/remoteControlSessionService", () => ({
  isRemoteControlControllerRole: (role: string) => role === "Admin",
}));
vi.mock("../server/services/remoteSupportRuntime", () => ({
  recordRemoteSupportCommandTelemetry: h.telemetry,
}));

vi.mock("ws", () => {
  class MockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = MockWebSocket.OPEN;
    send = vi.fn();
    ping = vi.fn();
    close = vi.fn((code?: number, reason?: string) => {
      this.readyState = MockWebSocket.CLOSED;
      this.emit("close", code, reason);
    });
    private handlers = new Map<string, Array<(...args: any[]) => void>>();
    on(event: string, handler: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    emit(event: string, ...args: any[]) {
      for (const handler of this.handlers.get(event) ?? []) handler(...args);
    }
  }
  class MockWebSocketServer {
    clients = new Set<any>();
    private handlers = new Map<string, Array<(...args: any[]) => void>>();
    constructor(_options: unknown) {
      h.server = this;
    }
    on(event: string, handler: (...args: any[]) => void) {
      const list = this.handlers.get(event) ?? [];
      list.push(handler);
      this.handlers.set(event, list);
      return this;
    }
    connect(socket: any, request: any = {}) {
      this.clients.add(socket);
      for (const handler of this.handlers.get("connection") ?? []) handler(socket, request);
    }
  }
  return { WebSocket: MockWebSocket, WebSocketServer: MockWebSocketServer };
});

import { WebSocket } from "ws";
import { broadcast, setupWS } from "../server/wsServer";

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const newSocket = () => new (WebSocket as any)();
const sessionWith =
  (session: Record<string, unknown>) =>
  (req: any, _res: any, next: (error?: unknown) => void): void => {
    req.session = session;
    next();
  };
const json = (value: unknown) => Buffer.from(JSON.stringify(value));

async function connected(session: Record<string, unknown>) {
  setupWS({} as any, sessionWith(session) as any);
  const socket = newSocket();
  h.server.connect(socket, {});
  await flush();
  return socket;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.remoteControl.mockResolvedValue(false);
  h.screenFeed.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe("websocket session resolution", () => {
  it("closes the socket when the session middleware throws synchronously", async () => {
    setupWS(
      {} as any,
      (() => {
        throw new Error("store crashed");
      }) as any
    );
    const socket = newSocket();
    h.server.connect(socket, {});
    await flush();
    expect(socket.close).toHaveBeenCalledWith(1013, "Session context unavailable");
    expect(h.warn).toHaveBeenCalledWith("[WS] Could not resolve the session for a socket.", expect.anything());
    expect(h.cleanupRemote).toHaveBeenCalledWith(socket);
    expect(h.cleanupFeed).toHaveBeenCalledWith(socket);
  });

  it("closes the socket when the session lookup never answers within five seconds", async () => {
    vi.useFakeTimers();
    setupWS({} as any, (() => undefined) as any);
    const socket = newSocket();
    h.server.connect(socket, {});
    await vi.advanceTimersByTimeAsync(5_001);
    expect(socket.close).toHaveBeenCalledWith(1013, "Session context unavailable");
  });

  it("does not close an already closed socket after an unresolved lookup", async () => {
    setupWS({} as any, ((_req: any, _res: any, next: (e?: unknown) => void) => next(new Error("down"))) as any);
    const socket = newSocket();
    socket.readyState = (WebSocket as any).CLOSED;
    h.server.connect(socket, {});
    await flush();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes through the failure path when closing after an unresolved lookup throws", async () => {
    setupWS({} as any, ((_req: any, _res: any, next: (e?: unknown) => void) => next(new Error("down"))) as any);
    const socket = newSocket();
    socket.close.mockImplementationOnce(() => {
      throw new Error("close failed");
    });
    h.server.connect(socket, {});
    await flush();
    expect(h.warn).toHaveBeenCalledWith(
      "[WS] Closing socket after unexpected session-resolution failure.",
      expect.anything()
    );
    expect(socket.close).toHaveBeenCalledTimes(2);
  });

  it("resolves a company-only session without a remote context, so its messages reach no transport", async () => {
    const socket = await connected({ factoryCompanyId: 4 });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "realtime:ready" }));
    socket.emit("message", json({ type: "remote-control:request" }), false);
    socket.emit("message", Buffer.from([1, 2, 3]), true);
    await flush();
    expect(h.remoteControl).not.toHaveBeenCalled();
    expect(h.screenFeed).not.toHaveBeenCalled();
    socket.close();
  });

  it("does not mark a socket ready when it closed before the session resolved", async () => {
    setupWS({} as any, sessionWith({ userId: "u1" }) as any);
    const socket = newSocket();
    socket.readyState = (WebSocket as any).CLOSED;
    h.server.connect(socket, {});
    await flush();
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe("websocket message routing", () => {
  it("routes remote-control messages, falls through when unhandled, and sends binary frames to the screen feed", async () => {
    const socket = await connected({ userId: "u1", username: "  amy ", role: "Viewer", currentCompanyId: 3 });
    h.remoteControl.mockResolvedValueOnce(true);
    socket.emit("message", json({ type: "remote-control:grant" }), false);
    await flush();
    expect(h.remoteControl).toHaveBeenCalledWith(
      socket,
      { userId: "u1", username: "amy", role: "Viewer", companyId: 3 },
      { type: "remote-control:grant" }
    );
    expect(h.screenFeed).not.toHaveBeenCalled();

    socket.emit("message", json({ type: "remote-control:unknown" }), false);
    socket.emit("message", Buffer.from([9, 9]), true);
    socket.emit("message", [Buffer.from("not"), Buffer.from(" json")], false);
    socket.emit("message", new Uint8Array(json([1, 2])).buffer, false);
    socket.emit("message", json({ type: 5 }), false);
    await flush();
    expect(h.screenFeed).toHaveBeenCalledTimes(5);
    const frames = h.screenFeed.mock.calls.map((call) => [call[2].toString("hex"), call[3]]);
    const hex = (text: string) => Buffer.from(text).toString("hex");
    expect(frames).toEqual(
      expect.arrayContaining([
        ["0909", true],
        [hex("not json"), false],
        [hex("[1,2]"), false],
        [hex('{"type":"remote-control:unknown"}'), false],
      ])
    );
    socket.close();
  });

  it("logs and survives a transport that rejects", async () => {
    const socket = await connected({ userId: "u1", currentRole: "Admin" });
    h.screenFeed.mockRejectedValueOnce(new Error("feed broke"));
    socket.emit("message", Buffer.from([1]), true);
    await flush();
    expect(h.warn).toHaveBeenCalledWith("[WS] Remote-support message failed.", expect.anything());
    socket.close();
  });

  it("records telemetry only from controller roles with complete identifiers", async () => {
    const viewer = await connected({ userId: "u2", currentRole: "Viewer" });
    const sent = { type: "remote-support:telemetry", event: "command-sent", commandId: "c1", targetUserId: "t1" };
    viewer.emit("message", json({ ...sent, targetTabId: "tab" }), false);
    await flush();
    expect(h.telemetry).not.toHaveBeenCalled();
    expect(h.screenFeed).not.toHaveBeenCalled();
    viewer.close();

    const admin = await connected({ userId: "u3", role: "Admin" });
    admin.emit("message", json(sent), false);
    admin.emit("message", json({ ...sent, targetTabId: "tab", sentAt: "17" }), false);
    admin.emit(
      "message",
      json({
        ...sent,
        event: "command-result",
        targetTabId: "tab",
        commandType: "click",
        sentAt: "x",
        executedAt: 20,
        status: "ok",
      }),
      false
    );
    admin.emit("message", json({ ...sent, event: "other", targetTabId: "tab" }), false);
    await flush();
    expect(h.telemetry.mock.calls).toEqual([
      [{ event: "sent", commandId: "c1", feedKey: "t1:tab", commandType: "unknown", sentAt: 17 }],
      [
        {
          event: "result",
          commandId: "c1",
          feedKey: "t1:tab",
          commandType: "click",
          sentAt: undefined,
          executedAt: 20,
          status: "ok",
        },
      ],
    ]);
    expect(h.screenFeed).not.toHaveBeenCalled();
    admin.close();
  });

  it("excludes the identified tab from its own broadcast and keeps a cleared id unscoped", async () => {
    const socket = await connected({ userId: "u9", currentCompanyId: 12 });
    socket.emit("message", json({ type: "realtime:identify", clientId: " tab-1 " }), false);
    socket.send.mockClear();
    broadcast({ type: "x" }, { companyId: 12, excludeRealtimeClientId: "tab-1" });
    expect(socket.send).not.toHaveBeenCalled();
    broadcast({ type: "y" }, { companyId: 12, excludeRealtimeClientId: "tab-2" });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "y" }));
    broadcast({ type: "z" }, { companyId: 99 });
    broadcast({ type: "w" }, { companyId: 12, userIds: ["someone-else"] });
    expect(socket.send).toHaveBeenCalledTimes(1);
    socket.emit("message", json({ type: "realtime:identify" }), false);
    broadcast({ type: "v" }, { companyId: 12, excludeRealtimeClientId: "tab-1" });
    expect(socket.send).toHaveBeenCalledTimes(2);
    expect(h.screenFeed).not.toHaveBeenCalled();
    socket.close();
  });

  it("pings open sockets every 30 seconds and stops after close", async () => {
    vi.useFakeTimers();
    const socket = await connected({ userId: "u5" });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.readyState = 2;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
    socket.readyState = (WebSocket as any).OPEN;
    socket.close();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.ping).toHaveBeenCalledTimes(1);
  });

  it("reports broadcast volume once the five-minute window has passed", async () => {
    vi.useFakeTimers();
    setupWS({} as any);
    const socket = newSocket();
    h.server.connect(socket, {});
    vi.setSystemTime(Date.now() + 6 * 60_000);
    broadcast({ type: "a" });
    expect(h.info).toHaveBeenCalledWith(
      "[WS] Broadcast volume",
      expect.objectContaining({ messagesDelivered: expect.any(Number) })
    );
    h.info.mockClear();
    broadcast({ type: "b" });
    expect(h.info).not.toHaveBeenCalled();
    socket.close();
  });
});

describe("websocket broadcast before setup", () => {
  it("is a no-op until the server exists", async () => {
    vi.resetModules();
    const fresh = await import("../server/wsServer");
    expect(() => fresh.broadcast({ type: "early" })).not.toThrow();
    expect(h.info).not.toHaveBeenCalled();
  });
});
