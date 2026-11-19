// Extracted from ./screenFeedRoutes.ts
import type { Request, Response } from "express";
import { logger } from "../lib/logger";
import { getSessionRole, getSessionUserId, getSessionUsername } from "../lib/requestContext";
import {
  normalizeScreenFeedTabId,
  screenFeedFailureStore,
  screenFeedStoreKey,
  watcherPollStore,
  type ScreenFeedCursor,
  type ScreenFeedFailureInfo,
  type ScreenFrame,
} from "../screenFeedStore";
import { isRemoteControlControllerRole } from "../services/remoteControlSessionService";
import { screenFeedLiveHub } from "../services/screenFeedLiveHub";
import { sanitizeScreenFeedFailure } from "../services/screenFeedService";
import { assertScreenFeedTenantAccess } from "../services/screenFeedTenantGate";
import { isRemoteSupportEnabled } from "../services/remoteSupportRuntime";

const WATCHER_TIMEOUT_MS = 12000;

export const LIVE_STATUS_REFRESH_MS = 4000;

export const LIVE_HEARTBEAT_MS = 5000;

export const MAX_FRAME_SIZE = 1_500_000;

type FlushableResponse = Response & { flush?: () => void };

export function requireDeveloper(req: Request, res: Response): boolean {
  if (getSessionRole(req) !== "Developer") {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

export function requireSupportController(req: Request, res: Response): boolean {
  if (!isRemoteControlControllerRole(getSessionRole(req))) {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

export function runtimeActor(req: Request): string {
  return String(getSessionUserId(req));
}

function sessionCompanyId(req: Request): number | null {
  const value = (req.session as { currentCompanyId?: unknown } | undefined)?.currentCompanyId;
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function sessionActor(req: Request) {
  return {
    userId: String(getSessionUserId(req)),
    username: getSessionUsername(req) || String(getSessionUserId(req)),
    role: getSessionRole(req) || "",
    companyId: sessionCompanyId(req),
  };
}

export function requestTabId(req: Request): string {
  return normalizeScreenFeedTabId(req.query.tabId ?? req.body?.tabId);
}

export async function authorizeFrameAccess(req: Request, res: Response, watchedUserId: string) {
  const actor = sessionActor(req);
  const gate = await assertScreenFeedTenantAccess({
    controllerRole: actor.role,
    controllerCompanyId: actor.companyId,
    watchedUserId,
  });
  if (!gate.allowed) {
    res.status(gate.status).json({ message: gate.message });
    return null;
  }
  return { actor, companyId: gate.companyId };
}

export function openEventStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

export function writeEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function writeHeartbeat(res: Response): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
  (res as FlushableResponse).flush?.();
}

export function isFeedBeingWatched(userId: string, tabId: string): boolean {
  const key = screenFeedStoreKey(userId, tabId);
  if (screenFeedLiveHub.hasViewer(key)) return true;
  const lastPoll = watcherPollStore.get(key) ?? 0;
  return lastPoll > 0 && Date.now() - lastPoll < WATCHER_TIMEOUT_MS;
}

export function serializeCursor(cursor: ScreenFeedCursor | null | undefined) {
  if (!cursor) return null;
  return { x: cursor.x, y: cursor.y, ts: cursor.ts, visible: cursor.visible };
}

export function serializeFailure(failure: ScreenFeedFailureInfo | null | undefined) {
  if (!failure) return null;
  return {
    stage: failure.stage,
    reason: failure.reason,
    occurredAt: failure.occurredAt.toISOString(),
    durationMs: failure.durationMs ?? null,
  };
}

export function serializeFrame(frame: ScreenFrame, failure?: ScreenFeedFailureInfo | null) {
  return {
    dataUrl: frame.dataUrl,
    capturedAt: frame.capturedAt.toISOString(),
    receivedAt: frame.capturedAt.toISOString(),
    clientCapturedAt: frame.clientCapturedAt?.toISOString() ?? null,
    username: frame.username,
    tabId: frame.tabId,
    clicks: frame.clicks,
    cursor: serializeCursor(frame.cursor),
    viewport: frame.viewport ?? null,
    capture: frame.capture ?? null,
    captureFailure: serializeFailure(failure),
  };
}

export function recordCaptureFailure(userId: string, tabId: string, value: unknown): boolean {
  const sanitized = sanitizeScreenFeedFailure(value);
  if (!sanitized) return false;
  const failure: ScreenFeedFailureInfo = { ...sanitized, occurredAt: new Date() };
  const key = screenFeedStoreKey(userId, tabId);
  screenFeedFailureStore.set(key, failure);
  logger.warn(
    `[ScreenFeed] capture failure userId=${userId} tabId=${tabId} stage=${failure.stage} durationMs=${failure.durationMs ?? "unknown"} reason=${failure.reason}`
  );
  if (isRemoteSupportEnabled("fastScreenFeed")) screenFeedLiveHub.publishFailure(key, failure);
  return true;
}
