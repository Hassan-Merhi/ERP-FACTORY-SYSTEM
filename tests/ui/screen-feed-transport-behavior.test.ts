/**
 * Remote-support screen feed transport. Frames travel as binary packets over
 * the shared /ws socket; when that socket is not ready a viewer falls back to
 * polling /api/screen-feed/:userId and a sender falls back to POSTing a data
 * URL. These cases drive the real module against a fake WebSocket and fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeRemoteSupportBinaryPacket,
  encodeRemoteSupportBinaryPacket,
  type RemoteSupportFrameHeader,
} from "@shared/remoteSupportTransport";

class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  readyState = 0;
  binaryType = "";
  sent: unknown[] = [];
  closed: Array<[number | undefined, string | undefined]> = [];
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: unknown) {
    this.sent.push(data);
  }
  close(code?: number, reason?: string) {
    this.closed.push([code, reason]);
    this.readyState = 3;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
  }
  ready() {
    this.open();
    this.onmessage?.({ data: JSON.stringify({ type: "realtime:ready" }) });
  }
}

const header: RemoteSupportFrameHeader = {
  type: "screen-feed-frame",
  version: 1,
  tabId: "tab-1",
  capturedAt: "2026-09-23T10:00:00.000Z",
  metadata: { clicks: [{ x: 1 }], cursor: { x: 2, y: 3 }, viewport: { w: 100 }, capture: { q: 0.7 } },
};
const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

const originalWebSocket = globalThis.WebSocket;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  FakeSocket.instances = [];
  (globalThis as any).WebSocket = FakeSocket;
  (window as any).WebSocket = FakeSocket;
  window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  }) as typeof window.requestAnimationFrame;
});

afterEach(() => {
  vi.useRealTimers();
  (globalThis as any).WebSocket = originalWebSocket;
  (window as any).WebSocket = originalWebSocket;
  globalThis.fetch = originalFetch;
});

async function load() {
  return import("@/lib/screen-feed-binary-transport");
}

describe("WebSocket path", () => {
  it("connects on first subscriber, relays screen-feed status and ignores other traffic", async () => {
    const t = await load();
    const statuses: unknown[] = [];
    const release = t.subscribeScreenFeedTransportStatus((m) => statuses.push(m));
    const socket = FakeSocket.instances[0];
    expect(socket.url).toMatch(/^ws:\/\/.*\/ws$/);
    expect(socket.binaryType).toBe("arraybuffer");

    socket.ready();
    socket.onmessage?.({ data: JSON.stringify({ type: "screen-feed:viewer-bound", tabId: "t" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "invalidate", keys: [] }) });
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify([1, 2]) });

    expect(statuses).toEqual([
      { type: "screen-feed-transport-ready" },
      { type: "screen-feed:viewer-bound", tabId: "t" },
    ]);

    release();
    expect(socket.closed).toEqual([[1000, "Screen feed idle"]]);
  });

  it("decodes binary frames from ArrayBuffer and Blob messages", async () => {
    const t = await load();
    const frames: any[] = [];
    t.subscribeScreenFeedBinaryFrames((f) => frames.push(f));
    const socket = FakeSocket.instances[0];
    socket.ready();

    const packet = encodeRemoteSupportBinaryPacket(header, jpegBytes);
    socket.onmessage?.({ data: packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) });
    socket.onmessage?.({ data: new Blob([packet]) });
    socket.onmessage?.({ data: new ArrayBuffer(3) });
    await vi.waitFor(() => expect(frames).toHaveLength(2));

    expect(frames[0].header.tabId).toBe("tab-1");
    expect(Array.from(frames[0].jpeg)).toEqual(Array.from(jpegBytes));
  });

  it("sends control messages and frames only once the socket is ready", async () => {
    const t = await load();
    t.subscribeScreenFeedTransportStatus(() => {});
    const socket = FakeSocket.instances[0];

    expect(t.sendScreenFeedControlMessage({ type: "screen-feed:request-frame" })).toBe(false);
    socket.ready();
    expect(t.sendScreenFeedControlMessage({ type: "screen-feed:request-frame" })).toBe(true);
    expect(JSON.parse(String(socket.sent[0]))).toEqual({ type: "screen-feed:request-frame" });

    expect(await t.sendScreenFeedBinaryFrame(header, new Blob([jpegBytes]))).toBe(true);
    const decoded = decodeRemoteSupportBinaryPacket(new Uint8Array(socket.sent[1] as ArrayBuffer));
    expect(decoded?.header.capturedAt).toBe(header.capturedAt);
    expect(Array.from(decoded!.payload)).toEqual(Array.from(jpegBytes));
  });

  it("acknowledges a rendered frame for the bound viewer only", async () => {
    const t = await load();
    t.subscribeScreenFeedTransportStatus(() => {});
    const socket = FakeSocket.instances[0];
    socket.ready();
    t.sendScreenFeedControlMessage({ type: "screen-feed:viewer-bind", userId: " u1 ", tabId: "tab-1" });

    t.reportScreenFeedFrameRendered(header.capturedAt, "other-tab");
    t.reportScreenFeedFrameRendered("", "tab-1");
    t.reportScreenFeedFrameRendered(header.capturedAt, "tab-1");

    const acks = socket.sent.map((m) => JSON.parse(String(m))).filter((m) => m.type === "screen-feed:viewer-rendered");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toMatchObject({ userId: "u1", tabId: "tab-1", capturedAt: header.capturedAt });
  });

  it("reports a disconnect and reconnects while still subscribed", async () => {
    const t = await load();
    const statuses: any[] = [];
    t.subscribeScreenFeedTransportStatus((m) => statuses.push(m));
    const first = FakeSocket.instances[0];
    first.ready();

    first.onerror?.();
    expect(first.closed).toHaveLength(1);
    first.onclose?.();
    expect(statuses.at(-1)).toEqual({ type: "screen-feed-transport-disconnected" });

    vi.advanceTimersByTime(1600);
    expect(FakeSocket.instances).toHaveLength(2);
  });
});

describe("HTTP fallbacks", () => {
  it("POSTs the frame as a data URL when the socket is not ready", async () => {
    const posts: any[] = [];
    globalThis.fetch = vi.fn(async (_url: any, init: any) => {
      posts.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }) as any;
    vi.useRealTimers();
    const t = await load();

    expect(await t.sendScreenFeedBinaryFrame(header, new Blob([jpegBytes], { type: "image/jpeg" }))).toBe(true);
    expect(posts[0]).toMatchObject({
      tabId: "tab-1",
      clientCapturedAt: header.capturedAt,
      clicks: [{ x: 1 }],
      cursor: { x: 2, y: 3 },
    });
    expect(posts[0].dataUrl).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("returns false when the fallback POST fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError("offline");
    }) as any;
    vi.useRealTimers();
    const t = await load();
    expect(await t.sendScreenFeedBinaryFrame(header, new Blob([jpegBytes]))).toBe(false);
  });

  it("polls the viewer fallback, emits legacy frames and failures, and honours ETags", async () => {
    const dataUrl = `data:image/jpeg;base64,${btoa(String.fromCharCode(...jpegBytes))}`;
    const requests: Array<{ url: string; etag?: string }> = [];
    const responses = [
      new Response(
        JSON.stringify({
          dataUrl,
          capturedAt: "2026-09-23T10:00:05.000Z",
          clicks: [],
          captureFailure: { stage: "encode", reason: "busy", occurredAt: "x" },
        }),
        { status: 200, headers: { ETag: '"v1"' } }
      ),
      new Response(null, { status: 304 }),
      new Response("nope", { status: 403 }),
    ];
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      requests.push({ url: String(url), etag: init.headers["If-None-Match"] });
      return responses.shift() ?? new Response(null, { status: 304 });
    }) as any;

    const t = await load();
    const frames: any[] = [];
    const statuses: any[] = [];
    t.subscribeScreenFeedTransportStatus((m) => statuses.push(m));
    t.subscribeScreenFeedBinaryFrames((f) => frames.push(f));
    t.sendScreenFeedControlMessage({ type: "screen-feed:viewer-bind", userId: "u 1", tabId: "tab-9" });

    await vi.advanceTimersByTimeAsync(0);
    expect(requests[0].url).toBe("/api/screen-feed/u%201?tabId=tab-9");
    expect(frames).toHaveLength(1);
    expect(frames[0].header).toMatchObject({ tabId: "tab-9", capturedAt: "2026-09-23T10:00:05.000Z" });
    expect(frames[0].header.metadata.transport).toBe("http-fallback");
    expect(statuses).toEqual(
      expect.arrayContaining([
        { type: "screen-feed:failure", tabId: "tab-9", failure: { stage: "encode", reason: "busy", occurredAt: "x" } },
        { type: "screen-feed:viewer-bound", userId: "u 1", tabId: "tab-9" },
      ])
    );

    await vi.advanceTimersByTimeAsync(1200);
    expect(requests[1].etag).toBe('"v1"');
    await vi.advanceTimersByTimeAsync(1200);
    expect(statuses.at(-1)).toEqual({ type: "screen-feed:error", code: "http-fallback-rejected", status: 403 });

    // Once the socket becomes ready, polling stops.
    FakeSocket.instances[0].ready();
    const count = requests.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(requests.length).toBe(count);
  });

  it("ignores non-JPEG legacy payloads", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ dataUrl: "data:image/png;base64,AAAA" }), { status: 200 })
    ) as any;
    const t = await load();
    const frames: any[] = [];
    t.subscribeScreenFeedBinaryFrames((f) => frames.push(f));
    t.sendScreenFeedControlMessage({ type: "screen-feed:viewer-bind", userId: "u1", tabId: "tab-1" });
    await vi.advanceTimersByTimeAsync(0);
    expect(frames).toEqual([]);
  });
});
