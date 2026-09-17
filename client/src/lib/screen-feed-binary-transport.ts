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

interface LegacyScreenFramePayload {
  dataUrl?: unknown;
  capturedAt?: unknown;
  clientCapturedAt?: unknown;
  tabId?: unknown;
  clicks?: unknown;
  cursor?: unknown;
  viewport?: unknown;
  capture?: unknown;
  captureFailure?: unknown;
}

const VIEWER_FALLBACK_POLL_MS = 1200;
const VIEWER_FALLBACK_ERROR_POLL_MS = 2500;
const frameListeners = new Set<FrameListener>();
const statusListeners = new Set<StatusListener>();
let socket: WebSocket | null = null;
let ready = false;
let reconnectTimer: number | null = null;
let refs = 0;
let viewerBinding: ViewerBinding | null = null;
let viewerPollTimer: number | null = null;
let viewerPollAbort: AbortController | null = null;
let viewerPollEtag: string | null = null;
let viewerPollBindingKey = "";
let viewerPollFailureKey = "";

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

function emitFrame(frame: ScreenFeedBinaryFrame): void {
  for (const listener of frameListeners) listener(frame);
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function normalizedViewerBinding(message: Record<string, unknown>): ViewerBinding | null {
  if (message.type !== "screen-feed:viewer-bind") return null;
  const userId = typeof message.userId === "string" ? message.userId.trim().slice(0, 128) : "";
  const tabId = typeof message.tabId === "string" ? message.tabId.trim().slice(0, 160) : "";
  return userId && tabId ? { userId, tabId } : null;
}

function bindingKey(binding: ViewerBinding | null): string {
  return binding ? `${binding.userId}:${binding.tabId}` : "";
}

function stopViewerPollingFallback(resetValidator = false): void {
  if (viewerPollTimer !== null) window.clearTimeout(viewerPollTimer);
  viewerPollTimer = null;
  viewerPollAbort?.abort();
  viewerPollAbort = null;
  if (resetValidator) {
    viewerPollEtag = null;
    viewerPollBindingKey = "";
    viewerPollFailureKey = "";
  }
}

function legacyDataUrlToBytes(value: unknown): Uint8Array | null {
  if (typeof value !== "string") return null;
  const comma = value.indexOf(",");
  if (comma <= 0) return null;
  const prefix = value.slice(0, comma).toLowerCase();
  if (!prefix.startsWith("data:image/jpeg") && !prefix.startsWith("data:image/jpg")) return null;
  if (!prefix.includes(";base64")) return null;
  try {
    const binary = window.atob(value.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

function emitLegacyFrame(binding: ViewerBinding, payload: LegacyScreenFramePayload): boolean {
  const jpeg = legacyDataUrlToBytes(payload.dataUrl);
  if (!jpeg) return false;
  const capturedAt =
    typeof payload.clientCapturedAt === "string" && payload.clientCapturedAt
      ? payload.clientCapturedAt
      : typeof payload.capturedAt === "string" && payload.capturedAt
        ? payload.capturedAt
        : new Date().toISOString();
  emitFrame({
    header: {
      type: "screen-feed-frame",
      version: 1,
      tabId: binding.tabId,
      capturedAt,
      metadata: {
        clicks: Array.isArray(payload.clicks) ? payload.clicks : [],
        cursor: objectRecord(payload.cursor),
        viewport: objectRecord(payload.viewport),
        capture: objectRecord(payload.capture),
        transport: "http-fallback",
      },
    },
    jpeg,
  });
  return true;
}

function emitLegacyFailure(payload: LegacyScreenFramePayload, binding: ViewerBinding): void {
  const failure = objectRecord(payload.captureFailure);
  if (!failure) return;
  const failureKey = JSON.stringify([bindingKey(binding), failure.stage, failure.reason, failure.occurredAt]);
  if (failureKey === viewerPollFailureKey) return;
  viewerPollFailureKey = failureKey;
  emitStatus({ type: "screen-feed:failure", tabId: binding.tabId, failure });
}

function scheduleViewerPollingFallback(delayMs = VIEWER_FALLBACK_POLL_MS): void {
  if (
    viewerPollTimer !== null ||
    !viewerBinding ||
    frameListeners.size === 0 ||
    (socket?.readyState === WebSocket.OPEN && ready)
  ) {
    return;
  }
  viewerPollTimer = window.setTimeout(() => {
    viewerPollTimer = null;
    void pollViewerFallback();
  }, delayMs);
}

async function pollViewerFallback(): Promise<void> {
  const binding = viewerBinding;
  if (!binding || frameListeners.size === 0 || (socket?.readyState === WebSocket.OPEN && ready)) return;
  const key = bindingKey(binding);
  if (viewerPollBindingKey !== key) {
    viewerPollBindingKey = key;
    viewerPollEtag = null;
    viewerPollFailureKey = "";
  }

  const controller = new AbortController();
  viewerPollAbort?.abort();
  viewerPollAbort = controller;
  try {
    const headers: HeadersInit = {};
    if (viewerPollEtag) headers["If-None-Match"] = viewerPollEtag;
    const response = await fetch(
      `/api/screen-feed/${encodeURIComponent(binding.userId)}?tabId=${encodeURIComponent(binding.tabId)}`,
      {
        method: "GET",
        credentials: "include",
        headers,
        signal: controller.signal,
        cache: "no-store",
      }
    );
    if (response.status === 304) {
      scheduleViewerPollingFallback();
      return;
    }
    if (!response.ok) {
      emitStatus({
        type: "screen-feed:error",
        message: `Screen-feed HTTP fallback rejected (${response.status}).`,
      });
      scheduleViewerPollingFallback(VIEWER_FALLBACK_ERROR_POLL_MS);
      return;
    }
    viewerPollEtag = response.headers.get("ETag") || null;
    const payload = (await response.json()) as LegacyScreenFramePayload | null;
    if (payload) {
      emitLegacyFailure(payload, binding);
      if (emitLegacyFrame(binding, payload)) {
        emitStatus({ type: "screen-feed:viewer-bound", userId: binding.userId, tabId: binding.tabId });
      }
    }
    scheduleViewerPollingFallback();
  } catch (error) {
    if (controller.signal.aborted) return;
    emitStatus({
      type: "screen-feed:error",
      message: error instanceof Error ? error.message : "Screen-feed HTTP fallback failed.",
    });
    scheduleViewerPollingFallback(VIEWER_FALLBACK_ERROR_POLL_MS);
  } finally {
    if (viewerPollAbort === controller) viewerPollAbort = null;
  }
}

function updateViewerBinding(binding: ViewerBinding): void {
  const nextKey = bindingKey(binding);
  if (nextKey !== bindingKey(viewerBinding)) {
    stopViewerPollingFallback(true);
    viewerBinding = binding;
  } else {
    viewerBinding = binding;
  }
  if (!ready || socket?.readyState !== WebSocket.OPEN) scheduleViewerPollingFallback(0);
}

function scheduleReconnect(): void {
  if (!shouldRun() || reconnectTimer !== null) return;
  reconnectTimer = window.setTimeout(
    () => {
      reconnectTimer = null;
      connect();
    },
    1000 + Math.floor(Math.random() * 500)
  );
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
          stopViewerPollingFallback();
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
      emitFrame({ header: decoded.header, jpeg: decoded.payload });
    };
    if (event.data instanceof ArrayBuffer) consume(new Uint8Array(event.data));
    else if (event.data instanceof Blob)
      void event.data.arrayBuffer().then((buffer) => consume(new Uint8Array(buffer)));
  };

  next.onclose = () => {
    if (socket !== next) return;
    socket = null;
    ready = false;
    emitStatus({ type: "screen-feed-transport-disconnected" });
    scheduleViewerPollingFallback(0);
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
      stopViewerPollingFallback(true);
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
  if (viewerBinding && (!ready || socket?.readyState !== WebSocket.OPEN)) scheduleViewerPollingFallback(0);
  return () => {
    frameListeners.delete(listener);
    if (frameListeners.size === 0) stopViewerPollingFallback();
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
  const binding = normalizedViewerBinding(message);
  if (binding) updateViewerBinding(binding);
  if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Unable to encode screen-feed fallback frame."));
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unable to encode screen-feed fallback frame."));
        return;
      }
      resolve(reader.result);
    };
    reader.readAsDataURL(blob);
  });
}

async function sendScreenFeedHttpFallback(header: RemoteSupportFrameHeader, jpeg: Blob): Promise<boolean> {
  const metadata = header.metadata ?? {};
  const response = await fetch("/api/screen-feed", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tabId: header.tabId,
      dataUrl: await blobToDataUrl(jpeg),
      clicks: Array.isArray(metadata.clicks) ? metadata.clicks : [],
      cursor: objectRecord(metadata.cursor),
      viewport: objectRecord(metadata.viewport),
      capture: objectRecord(metadata.capture),
      clientCapturedAt: header.capturedAt,
    }),
  });
  return response.ok;
}

async function trySendScreenFeedBinaryFrame(header: RemoteSupportFrameHeader, jpeg: Blob): Promise<boolean> {
  if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return false;
  const bytes = new Uint8Array(await jpeg.arrayBuffer());
  const packet = encodeRemoteSupportBinaryPacket(header, bytes);
  const packetBuffer = packet.buffer.slice(packet.byteOffset, packet.byteOffset + packet.byteLength) as ArrayBuffer;
  socket.send(packetBuffer);
  return true;
}

export async function sendScreenFeedBinaryFrame(header: RemoteSupportFrameHeader, jpeg: Blob): Promise<boolean> {
  try {
    if (await trySendScreenFeedBinaryFrame(header, jpeg)) return true;
  } catch {
    // A binary encode/send failure still gets one chance through the recovery path.
  }
  try {
    return await sendScreenFeedHttpFallback(header, jpeg);
  } catch {
    return false;
  }
}
