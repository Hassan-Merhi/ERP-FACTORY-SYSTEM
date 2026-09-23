/**
 * Remote-control request/response transport over the shared /ws socket.
 * A support agent's mouse/keyboard command is sent with a request id and must
 * resolve or reject exactly once: on the matching response, on a timeout, or
 * when the socket drops. Latency telemetry is recorded from the published
 * command to its execution result. Driven against a fake WebSocket.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  throwOnSend = false;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string) {
    if (this.throwOnSend) throw new Error("socket send failed");
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed.push([code, reason]);
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: typeof message === "string" ? message : JSON.stringify(message) });
  }
  ready() {
    this.readyState = FakeSocket.OPEN;
    this.deliver({ type: "realtime:ready" });
  }
  lastRequest() {
    return JSON.parse(this.sent.at(-1)!);
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeSocket.instances = [];
  (globalThis as any).WebSocket = FakeSocket;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as any).WebSocket = originalWebSocket;
});

async function connected() {
  const t = await import("@/lib/remote-control-session-transport");
  const messages: any[] = [];
  const release = t.subscribeRemoteControlRealtime((m) => messages.push(m));
  const socket = FakeSocket.instances[0];
  return { t, socket, messages, release };
}

describe("readiness", () => {
  it("reports readiness to ready listeners and rejects requests before it", async () => {
    const t = await import("@/lib/remote-control-session-transport");
    const states: boolean[] = [];
    const release = t.subscribeRemoteControlRealtimeReady((ready) => states.push(ready));

    await expect(t.requestRemoteControlRealtime({ type: "remote-control:mouse" })).rejects.toMatchObject({
      code: "TRANSPORT_NOT_READY",
    });

    FakeSocket.instances[0].ready();
    expect(states).toEqual([false, true]);
    expect(t.isRemoteControlRealtimeReady()).toBe(true);

    release();
    // The listener is removed before the socket is torn down, so it is not
    // called again; the transport itself reports not-ready.
    expect(states).toEqual([false, true]);
    expect(t.isRemoteControlRealtimeReady()).toBe(false);
    expect(FakeSocket.instances[0].closed).toEqual([[1000, "Remote control idle"]]);
  });
});

describe("request / response", () => {
  it("resolves the matching response and forwards messages to subscribers", async () => {
    const { t, socket, messages } = await connected();
    socket.ready();

    const pending = t.requestRemoteControlRealtime({ type: "remote-control:mouse", x: 1 });
    const { requestId, x } = socket.lastRequest();
    expect(x).toBe(1);
    socket.deliver({ type: "remote-control:response", requestId: "someone-else", ok: true });
    socket.deliver({ type: "remote-control:response", requestId, ok: true, value: 42 });

    await expect(pending).resolves.toMatchObject({ requestId, value: 42 });
    expect(messages.map((m) => m.requestId)).toEqual(["someone-else", requestId]);
  });

  it("rejects with the server's status, code, message and retry hint", async () => {
    const { t, socket } = await connected();
    socket.ready();

    const pending = t.requestRemoteControlRealtime({ type: "remote-control:keyboard" });
    const { requestId } = socket.lastRequest();
    socket.deliver({
      type: "remote-control:response",
      requestId,
      ok: false,
      status: 429,
      code: "RATE_LIMITED",
      message: "Slow down",
      retryAfterMs: 750,
    });

    await expect(pending).rejects.toMatchObject({
      name: "RemoteControlRealtimeError",
      status: 429,
      code: "RATE_LIMITED",
      message: "Slow down",
      retryAfterMs: 750,
    });
  });

  it("uses safe defaults when a failure response carries no details", async () => {
    const { t, socket } = await connected();
    socket.ready();
    const pending = t.requestRemoteControlRealtime({ type: "remote-control:keyboard" });
    socket.deliver({ type: "remote-control:response", requestId: socket.lastRequest().requestId, ok: false });
    await expect(pending).rejects.toMatchObject({ status: 500, code: null, retryAfterMs: null });
  });

  it("times out an unanswered request", async () => {
    const { t, socket } = await connected();
    socket.ready();
    const pending = t.requestRemoteControlRealtime({ type: "remote-control:mouse" }, 1000);
    const assertion = expect(pending).rejects.toMatchObject({ code: "TRANSPORT_TIMEOUT" });
    vi.advanceTimersByTime(1000);
    await assertion;
  });

  it("rejects when the socket send throws", async () => {
    const { t, socket } = await connected();
    socket.ready();
    socket.throwOnSend = true;
    await expect(t.requestRemoteControlRealtime({ type: "remote-control:mouse" })).rejects.toThrow(
      "socket send failed"
    );
  });

  it("fails in-flight requests when the socket closes, then reconnects", async () => {
    const { t, socket } = await connected();
    socket.ready();
    const pending = t.requestRemoteControlRealtime({ type: "remote-control:mouse" });
    const assertion = expect(pending).rejects.toMatchObject({ code: "TRANSPORT_DISCONNECTED" });

    socket.onerror?.();
    expect(socket.closed).toHaveLength(1);
    socket.onclose?.();
    await assertion;
    expect(t.isRemoteControlRealtimeReady()).toBe(false);

    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(2);
  });

  it("ignores binary and malformed traffic on the shared socket", async () => {
    const { socket, messages } = await connected();
    socket.ready();
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    socket.deliver("{not json");
    socket.deliver({ noType: true });
    expect(messages).toEqual([]);
  });
});

describe("command latency telemetry", () => {
  it("records command-sent on publish and command-result on execution", async () => {
    const { t, socket } = await connected();
    socket.ready();

    const pending = t.requestRemoteControlRealtime({ type: "remote-control:mouse" });
    const { requestId } = socket.lastRequest();
    socket.deliver({
      type: "remote-control:response",
      requestId,
      ok: true,
      command: {
        id: "cmd-1",
        targetUserId: "u1",
        targetTabId: "tab-1",
        type: "click",
        createdAt: "2026-09-23T10:00:00.000Z",
      },
    });
    await pending;
    socket.deliver({
      type: "remote-control:mouse-result",
      result: { commandId: "cmd-1", completedAt: Date.parse("2026-09-23T10:00:00.250Z"), status: "executed" },
    });
    // A result for an unknown command, or with no completion time, records nothing.
    socket.deliver({ type: "remote-control:keyboard-result", result: { commandId: "cmd-x", completedAt: 1 } });

    const telemetry = socket.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "remote-support:telemetry");
    expect(telemetry).toEqual([
      expect.objectContaining({ event: "command-sent", commandId: "cmd-1", commandType: "click" }),
      expect.objectContaining({
        event: "command-result",
        commandId: "cmd-1",
        status: "executed",
        sentAt: Date.parse("2026-09-23T10:00:00.000Z"),
        executedAt: Date.parse("2026-09-23T10:00:00.250Z"),
      }),
    ]);
  });

  it("skips telemetry for failed or incomplete published commands", async () => {
    const { socket } = await connected();
    socket.ready();
    socket.deliver({ type: "remote-control:response", requestId: "r1", ok: false, command: { id: "c" } });
    socket.deliver({
      type: "remote-control:response",
      requestId: "r2",
      ok: true,
      command: { id: "c2", targetUserId: "u" },
    });
    socket.deliver({ type: "remote-control:response", requestId: "r3", ok: true, command: "nope" });
    expect(socket.sent).toEqual([]);
  });
});
