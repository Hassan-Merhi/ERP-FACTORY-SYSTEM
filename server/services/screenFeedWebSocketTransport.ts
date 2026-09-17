import type { WebSocket } from "ws";
import { decodeRemoteSupportBinaryPacket, REMOTE_SUPPORT_MAX_FRAME_BYTES } from "@shared/remoteSupportTransport";
import { isRemoteControlControllerRole, listRemoteControlTabs } from "./remoteControlSessionService";
import { assertScreenFeedTenantAccess } from "./screenFeedTenantGate";
import {
  isRemoteSupportEnabled,
  recordRemoteSupportFrameReceived,
  recordRemoteSupportMetric,
  recordRemoteSupportViewerRendered,
} from "./remoteSupportRuntime";

export interface ScreenFeedSocketContext {
  userId: string;
  username: string;
  role: string;
  companyId: number | null;
}

type SocketWithState = WebSocket;

const producers = new Map<string, Set<SocketWithState>>();
const viewers = new Map<string, Set<SocketWithState>>();
const latestFrames = new Map<string, { packet: Buffer; capturedAt: number }>();
const producerKeysBySocket = new WeakMap<SocketWithState, Set<string>>();
const viewerKeysBySocket = new WeakMap<SocketWithState, Set<string>>();
const FRAME_RETENTION_MS = 2 * 60 * 1000;
const OPEN = 1;

function clean(value: unknown, max = 160): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function screenFeedSocketKey(userId: string, tabId: string): string {
  return `${clean(userId, 128)}\u0000${clean(tabId, 160)}`;
}

function safeSendJson(socket: SocketWithState, payload: unknown): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(JSON.stringify(payload));
  } catch {
    // Connection cleanup removes dead sockets.
  }
}

function safeSendBinary(socket: SocketWithState, packet: Buffer): void {
  if (socket.readyState !== OPEN) return;
  try {
    socket.send(packet, { binary: true });
  } catch {
    // Connection cleanup removes dead sockets.
  }
}

function addSocket(map: Map<string, Set<SocketWithState>>, key: string, socket: SocketWithState): void {
  const set = map.get(key) ?? new Set<SocketWithState>();
  set.add(socket);
  map.set(key, set);
}

function removeSocket(map: Map<string, Set<SocketWithState>>, key: string, socket: SocketWithState): void {
  const set = map.get(key);
  if (!set) return;
  set.delete(socket);
  if (set.size === 0) map.delete(key);
}

function rememberSocketKey(store: WeakMap<SocketWithState, Set<string>>, socket: SocketWithState, key: string): void {
  const keys = store.get(socket) ?? new Set<string>();
  keys.add(key);
  store.set(socket, keys);
}

function notifyProducerStatus(key: string): void {
  const watched = (viewers.get(key)?.size ?? 0) > 0;
  for (const producer of producers.get(key) ?? []) {
    safeSendJson(producer, {
      type: "screen-feed:status",
      watched,
      fast: watched && isRemoteSupportEnabled("fastScreenFeed"),
    });
  }
}

function clearViewerBindings(socket: SocketWithState): void {
  const keys = viewerKeysBySocket.get(socket);
  if (!keys) return;
  for (const key of keys) {
    removeSocket(viewers, key, socket);
    notifyProducerStatus(key);
  }
  keys.clear();
}

function registeredTab(context: ScreenFeedSocketContext, tabId: string) {
  return listRemoteControlTabs(context.userId).find((tab) => tab.tabId === tabId);
}

function bindProducer(socket: SocketWithState, context: ScreenFeedSocketContext, tabIdRaw: unknown): boolean {
  const tabId = clean(tabIdRaw);
  if (!tabId) {
    safeSendJson(socket, {
      type: "screen-feed:error",
      code: "INVALID_TAB_ID",
      message: "ERP tab identifier is required.",
    });
    return false;
  }

  const knownTab = registeredTab(context, tabId);
  if (knownTab && context.companyId && knownTab.companyId !== context.companyId) {
    safeSendJson(socket, {
      type: "screen-feed:error",
      code: "TAB_COMPANY_MISMATCH",
      message: "ERP tab belongs to a different company context.",
    });
    return false;
  }

  const key = screenFeedSocketKey(context.userId, tabId);
  addSocket(producers, key, socket);
  rememberSocketKey(producerKeysBySocket, socket, key);
  safeSendJson(socket, { type: "screen-feed:producer-bound", tabId });
  notifyProducerStatus(key);
  return true;
}

async function bindViewer(
  socket: SocketWithState,
  context: ScreenFeedSocketContext,
  watchedUserIdRaw: unknown,
  tabIdRaw: unknown
): Promise<boolean> {
  if (!isRemoteControlControllerRole(context.role)) {
    safeSendJson(socket, { type: "screen-feed:error", code: "VIEW_NOT_AUTHORIZED", message: "Access denied." });
    return false;
  }
  const watchedUserId = clean(watchedUserIdRaw, 128);
  const tabId = clean(tabIdRaw);
  if (!watchedUserId || !tabId) {
    safeSendJson(socket, {
      type: "screen-feed:error",
      code: "INVALID_WATCH_TARGET",
      message: "A user and ERP tab are required.",
    });
    return false;
  }

  const gate = await assertScreenFeedTenantAccess({
    controllerRole: context.role,
    controllerCompanyId: context.companyId,
    watchedUserId,
  });
  if (!gate.allowed) {
    safeSendJson(socket, { type: "screen-feed:error", code: "TENANT_ACCESS_DENIED", message: gate.message });
    return false;
  }

  const tab = listRemoteControlTabs(watchedUserId).find((candidate) => candidate.tabId === tabId);
  if (!tab || (context.role !== "Developer" && tab.companyId !== context.companyId)) {
    safeSendJson(socket, {
      type: "screen-feed:error",
      code: "TARGET_TAB_UNAVAILABLE",
      message: "The selected ERP tab is no longer available.",
    });
    return false;
  }

  clearViewerBindings(socket);
  const key = screenFeedSocketKey(watchedUserId, tabId);
  addSocket(viewers, key, socket);
  rememberSocketKey(viewerKeysBySocket, socket, key);
  safeSendJson(socket, { type: "screen-feed:viewer-bound", userId: watchedUserId, tabId });
  const latest = latestFrames.get(key);
  if (latest && Date.now() - latest.capturedAt <= FRAME_RETENTION_MS) safeSendBinary(socket, latest.packet);
  notifyProducerStatus(key);
  return true;
}

function recordViewerPaint(
  socket: SocketWithState,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): boolean {
  // Paint acknowledgements are accepted only from an authenticated support-role
  // socket that is already bound as the viewer for the exact user+tab feed.
  if (!isRemoteControlControllerRole(context.role)) return true;
  const watchedUserId = clean(message.userId, 128);
  const tabId = clean(message.tabId);
  if (!watchedUserId || !tabId) return true;
  const key = screenFeedSocketKey(watchedUserId, tabId);
  if (!viewerKeysBySocket.get(socket)?.has(key)) return true;

  const capturedAt = Date.parse(clean(message.capturedAt, 80));
  const viewerRenderedAt = finiteNumber(message.viewerRenderedAt);
  if (!Number.isFinite(capturedAt) || viewerRenderedAt == null) return true;
  recordRemoteSupportViewerRendered({ feedKey: key, capturedAt, viewerRenderedAt });
  return true;
}

function forwardProducerJson(
  socket: SocketWithState,
  context: ScreenFeedSocketContext,
  message: Record<string, unknown>
): boolean {
  const tabId = clean(message.tabId);
  const key = screenFeedSocketKey(context.userId, tabId);
  if (!producerKeysBySocket.get(socket)?.has(key)) return false;
  if (message.type !== "screen-feed:cursor" && message.type !== "screen-feed:failure") return false;
  const payload = { ...message, userId: context.userId, tabId };
  for (const viewer of viewers.get(key) ?? []) safeSendJson(viewer, payload);
  return true;
}

export async function handleScreenFeedWebSocketMessage(
  socket: SocketWithState,
  context: ScreenFeedSocketContext,
  data: Buffer,
  isBinary: boolean
): Promise<boolean> {
  if (isBinary) {
    if (!isRemoteSupportEnabled("screenFeedEnabled")) return true;
    if (data.byteLength > REMOTE_SUPPORT_MAX_FRAME_BYTES + 24 * 1024 + 5) {
      recordRemoteSupportMetric("frameRejected");
      safeSendJson(socket, {
        type: "screen-feed:error",
        code: "FRAME_TOO_LARGE",
        message: "Frame payload is too large.",
      });
      return true;
    }
    const decoded = decodeRemoteSupportBinaryPacket(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    if (!decoded) {
      recordRemoteSupportMetric("frameRejected");
      safeSendJson(socket, {
        type: "screen-feed:error",
        code: "INVALID_FRAME_PACKET",
        message: "Invalid screen frame packet.",
      });
      return true;
    }
    const key = screenFeedSocketKey(context.userId, decoded.header.tabId);
    if (!producerKeysBySocket.get(socket)?.has(key)) {
      safeSendJson(socket, {
        type: "screen-feed:error",
        code: "TAB_NOT_BOUND",
        message: "Bind the ERP tab before sending frames.",
      });
      return true;
    }

    const serverReceivedAt = Date.now();
    const capturedAt = Date.parse(decoded.header.capturedAt);
    const capture = metadataRecord(decoded.header.metadata.capture);
    const captureDurationMs = finiteNumber(capture?.durationMs);

    // Keep the exact received packet. No base64 conversion, JSON image copy or
    // re-encoding occurs between producer and viewers.
    latestFrames.set(key, { packet: data, capturedAt: serverReceivedAt });
    recordRemoteSupportMetric("frameAccepted", decoded.payload.byteLength);
    if (Number.isFinite(capturedAt)) {
      recordRemoteSupportFrameReceived({
        feedKey: key,
        capturedAt,
        serverReceivedAt,
        captureDurationMs,
      });
    }

    let delivered = 0;
    for (const viewer of viewers.get(key) ?? []) {
      safeSendBinary(viewer, data);
      delivered += 1;
    }
    if (delivered > 0) recordRemoteSupportMetric("framePushed", delivered);
    return true;
  }

  let message: Record<string, unknown>;
  try {
    const parsed = JSON.parse(data.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    message = parsed as Record<string, unknown>;
  } catch {
    return false;
  }

  if (message.type === "screen-feed:producer-bind") return bindProducer(socket, context, message.tabId);
  if (message.type === "screen-feed:viewer-bind") return bindViewer(socket, context, message.userId, message.tabId);
  if (message.type === "screen-feed:viewer-rendered") return recordViewerPaint(socket, context, message);
  if (typeof message.type === "string" && message.type.startsWith("screen-feed:")) {
    return forwardProducerJson(socket, context, message);
  }
  return false;
}

export function cleanupScreenFeedWebSocket(socket: SocketWithState): void {
  for (const key of producerKeysBySocket.get(socket) ?? []) removeSocket(producers, key, socket);
  producerKeysBySocket.delete(socket);
  clearViewerBindings(socket);
  viewerKeysBySocket.delete(socket);
}

export function cleanupExpiredScreenFeedWebSocketFrames(now = Date.now()): void {
  for (const [key, frame] of latestFrames) {
    if (now - frame.capturedAt > FRAME_RETENTION_MS) latestFrames.delete(key);
  }
}

export function resetScreenFeedWebSocketTransportForTests(): void {
  producers.clear();
  viewers.clear();
  latestFrames.clear();
}

const cleanupTimer = setInterval(() => cleanupExpiredScreenFeedWebSocketFrames(), 60_000);
(cleanupTimer as unknown as { unref?: () => void }).unref?.();
