import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  server: null as any,
}));

vi.mock("../server/lib/observabilityBootstrap", () => ({}));
vi.mock("../server/lib/traceContext", () => ({
  runWithTraceContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../server/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
      harness.server = this;
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

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("Phase 33F websocket auth and broadcast scoping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.server = null;
  });

  it("marks an authenticated socket ready only after session company/user scope resolves", async () => {
    setupWS(
      {} as any,
      ((req: any, _res: any, next: (error?: unknown) => void) => {
        req.session = { userId: "user-7", currentCompanyId: 7, factoryCompanyId: 11 };
        next();
      }) as any
    );

    const socket = new (WebSocket as any)();
    harness.server.connect(socket, {});
    await flush();

    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "realtime:ready" }));

    broadcast({ type: "invalidate", topic: "inventory" }, { companyId: 7, userIds: ["user-7"] });
    expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: "invalidate", topic: "inventory" }));
    socket.close();
  });

  it("fails closed for scoped broadcasts when a socket has no authenticated session context", async () => {
    setupWS(
      {} as any,
      ((req: any, _res: any, next: (error?: unknown) => void) => {
        req.session = {};
        next();
      }) as any
    );

    const socket = new (WebSocket as any)();
    harness.server.connect(socket, {});
    await flush();

    expect(socket.send).not.toHaveBeenCalled();
    broadcast({ type: "invalidate" }, { companyId: 7 });
    expect(socket.send).not.toHaveBeenCalled();
    socket.close();
  });

  it("closes sockets when session resolution fails instead of leaving them permanently unscoped", async () => {
    setupWS(
      {} as any,
      ((_req: any, _res: any, next: (error?: unknown) => void) => {
        next(new Error("session store unavailable"));
      }) as any
    );

    const socket = new (WebSocket as any)();
    harness.server.connect(socket, {});
    await flush();

    expect(socket.close).toHaveBeenCalledWith(1013, "Session context unavailable");
  });

  it("supports intentionally unscoped deployments while still filtering non-open sockets", async () => {
    setupWS({} as any);
    const openSocket = new (WebSocket as any)();
    const closedSocket = new (WebSocket as any)();
    closedSocket.readyState = (WebSocket as any).CLOSED;
    harness.server.connect(openSocket, {});
    harness.server.connect(closedSocket, {});
    await flush();

    expect(openSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "realtime:ready" }));
    openSocket.send.mockClear();
    closedSocket.send.mockClear();

    broadcast({ type: "system-ping" });
    expect(openSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: "system-ping" }));
    expect(closedSocket.send).not.toHaveBeenCalled();
    openSocket.close();
  });
});
