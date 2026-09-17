import {
  decodeRemoteSupportBinaryPacket,
  encodeRemoteSupportBinaryPacket,
  type RemoteSupportFrameHeader,
} from "@shared/remoteSupportTransport";

export interface ScreenFeedBinaryFrame {
  header: RemoteSupportFrameHeader;
  jpeg: Uint8Array;
}

type FrameListener = (frame: ScreenFeedBinaryFrame) => void;
type StatusListener = (message: Record<string, unknown>) => void;

interface ViewerBinding {
  userId: string;
  tabId: string;
}

const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | null = null;
let ready = false;
let reconnectTimer: number | null = null;
let refs = 0;
let viewerBinding: ViewerBinding | null = null;

function targetUrl(): string {
  const configured = (import.meta.env?.VITE_WS_URL as string) || "";
  if (configured) return configured;
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}/ws`;
}

function shouldRun(): boolean {
  return refs > 0 || frameListeners.size > 0 || statusListeners.size > 0;
}

function emitStatus(message: Record<string, unknown>): void {
  for (const listener of statusListeners) listener(message);
}

function scheduleReconnect(): void {
  if (!shouldRun() || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, 1000 + Math.floor(Math.random() * 500));
}

function connect(): void {
  if (socket || !shouldRun()) return;
  const next = new WebSocket(targetUrl());
  next.binaryType = "arraybuffer";
  socket = next;
  ready = false;

  next.onmessage = (event) => {
    if (socket !== next) return;
    if (typeof event.data === "string") {
      try {
        const value = JSON.parse(event.data) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) return;
        const message = value as Record<string, unknown>;
        if (message.type === "realtime:ready") {
          ready = true;
          emitStatus({ type: "screen-feed-transport-ready" });
          return;
        }
        if (typeof message.type === "string" && message.type.startsWith("screen-feed:")) emitStatus(message);
      } catch {
        // Ignore non-screen-feed traffic sharing /ws.
      }
      return;
    }

    const consume = (bytes: Uint8Array) => {
      const decoded = decodeRemoteSupportBinaryPacket(bytes);
      if (!decoded) return;
      for (const listener of frameListeners) listener({ header: decoded.header, jpeg: decoded.payload });
    };
    if (event.data instanceof ArrayBuffer) consume(new Uint8Array(event.data));
    else if (event.data instanceof Blob) void event.data.arrayBuffer().then((buffer) => consume(new Uint8Array(buffer)));
  };

  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    ready = false;
    emitStatus({ type: "screen-feed-transport-disconnected" });
    scheduleReconnect();
  };
  next.onerror = () => next.close();
}

function retain(): () => void {
  refs += 1;
  connect();
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    refs = Math.max(0, refs - 1);
    if (!shouldRun()) {
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      const current = socket;
      socket = null;
      ready = false;
      viewerBinding = null;
      current?.close(1000, "Screen feed idle");
    }
  };
}

export function subscribeScreenFeedTransportStatus(listener: StatusListener): () => void {
  statusListeners.add(listener);
  const release = retain();
  return () => {
    statusListeners.delete(listener);
    release();
  };
}

export function subscribeScreenFeedBinaryFrames(listener: FrameListener): () => void {
  frameListeners.add(listener);
  const release = retain();
  return () => {
    frameListeners.delete(listener);
    release();
  };
}

/**
 * Called by the actual <img> onLoad path. One animation frame after decode/load
 * is a closer approximation of browser-visible paint than acknowledging the
 * frame when the WebSocket message is merely dispatched to React.
 */
export function reportScreenFeedFrameRendered(capturedAt: string, tabId: string): void {
  const binding = viewerBinding;
  if (!binding || binding.tabId !== tabId || !capturedAt) return;
  window.requestAnimationFrame(() => {
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !ready ||
      viewerBinding?.userId !== binding.userId ||
      viewerBinding?.tabId !== binding.tabId
    ) {
      return;
    }
    socket.send(
      JSON.stringify({
        type: "screen-feed:viewer-rendered",
        userId: binding.userId,
        tabId: binding.tabId,
        capturedAt,
        viewerRenderedAt: Date.now(),
      })
    );
  });
}

export function sendScreenFeedControlMessage(message: Record<string, unknown>): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return false;
  if (message.type === "screen-feed:viewer-bind") {
    const userId = typeof message.userId === "string" ? message.userId.trim().slice(0, 128) : "";
    const tabId = typeof message.tabId === "string" ? message.tabId.trim().slice(0, 160) : "";
    if (userId && tabId) viewerBinding = { userId, tabId };
  }
  socket.send(JSON.stringify(message));
  return true;
}

export async function sendScreenFeedBinaryFrame(header: RemoteSupportFrameHeader, jpeg: Blob): Promise<boolean> {
  if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return false;
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const packet = encodeRemoteSupportBinaryPacket(header, bytes);
  const packetBuffer = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
  socket.send(packetBuffer);
  return true;
}
