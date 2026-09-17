import type { Express, Request, Response } from "express";
import { requireAuth, requireLogin } from "../auth";
import { logger } from "../lib/logger";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getSessionRole, getSessionUserId, getSessionUsername } from "../lib/requestContext";
import {
  normalizeScreenFeedTabId,
  screenFeedCursorStore,
  screenFeedFailureStore,
  screenFeedStore,
  screenFeedStoreKey,
  watcherPollStore,
  type ScreenFeedCursor,
  type ScreenFeedFailureInfo,
  type ScreenFrame,
} from "../screenFeedStore";
import { isRemoteControlControllerRole, stopAllRemoteControlSessions } from "../services/remoteControlSessionService";
import { getRemoteSupportCommandAuditHealth } from "../services/remoteSupportCommandAuditQueue";
import { screenFeedLiveHub } from "../services/screenFeedLiveHub";
import {
  isValidScreenFeedDataUrl,
  sanitizeScreenFeedCapture,
  sanitizeScreenFeedClicks,
  sanitizeScreenFeedClientCapturedAt,
  sanitizeScreenFeedCursor,
  sanitizeScreenFeedFailure,
  sanitizeScreenFeedViewport,
} from "../services/screenFeedService";
import { assertScreenFeedTenantAccess } from "../services/screenFeedTenantGate";
import { beginScreenWatch, endScreenWatch } from "../services/screenWatchAuditService";
import {
  emergencyDisableRemoteSupport,
  getRemoteSupportRuntimeSnapshot,
  isRemoteSupportEnabled,
  recordRemoteSupportMetric,
  resetRemoteSupportMetrics,
  restoreRemoteSupportBootDefaults,
  updateRemoteSupportFlags,
} from "../services/remoteSupportRuntime";

const WATCHER_TIMEOUT_MS = 12000;
const LIVE_STATUS_REFRESH_MS = 4000;
const LIVE_HEARTBEAT_MS = 5000;
const MAX_FRAME_SIZE = 1_500_000;
const isDev = process.env.NODE_ENV !== "production";
const viewPermission = requireActionAccess("remote_support_view");

type FlushableResponse = Response & { flush?: () => void };

function requireDeveloper(req: Request, res: Response): boolean {
  if (getSessionRole(req) !== "Developer") {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

function requireSupportController(req: Request, res: Response): boolean {
  if (!isRemoteControlControllerRole(getSessionRole(req))) {
    res.status(403).json({ message: "Access denied." });
    return false;
  }
  return true;
}

function runtimeActor(req: Request): string {
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

function requestTabId(req: Request): string {
  return normalizeScreenFeedTabId(req.query.tabId ?? req.body?.tabId);
}

async function authorizeFrameAccess(req: Request, res: Response, watchedUserId: string) {
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

function openEventStream(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write("retry: 3000\n\n");
}

function writeEvent(res: Response, event: string, payload: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  (res as FlushableResponse).flush?.();
}

function writeHeartbeat(res: Response): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`: heartbeat ${Date.now()}\n\n`);
  (res as FlushableResponse).flush?.();
}

function isFeedBeingWatched(userId: string, tabId: string): boolean {
  const key = screenFeedStoreKey(userId, tabId);
  if (screenFeedLiveHub.hasViewer(key)) return true;
  const lastPoll = watcherPollStore.get(key) ?? 0;
  return lastPoll > 0 && Date.now() - lastPoll < WATCHER_TIMEOUT_MS;
}

function serializeCursor(cursor: ScreenFeedCursor | null | undefined) {
  if (!cursor) return null;
  return { x: cursor.x, y: cursor.y, ts: cursor.ts, visible: cursor.visible };
}

function serializeFailure(failure: ScreenFeedFailureInfo | null | undefined) {
  if (!failure) return null;
  return {
    stage: failure.stage,
    reason: failure.reason,
    occurredAt: failure.occurredAt.toISOString(),
    durationMs: failure.durationMs ?? null,
  };
}

function serializeFrame(frame: ScreenFrame, failure?: ScreenFeedFailureInfo | null) {
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

function recordCaptureFailure(userId: string, tabId: string, value: unknown): boolean {
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

export function registerScreenFeedRoutes(app: Express) {
  app.get("/api/screen-feed/admin/runtime", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json({ ...getRemoteSupportRuntimeSnapshot(), commandAuditQueue: getRemoteSupportCommandAuditHealth() });
  });

  app.get("/api/screen-feed/admin/audit-queue-health", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(getRemoteSupportCommandAuditHealth());
  });

  app.patch("/api/screen-feed/admin/runtime", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    const patch = req.body?.flags ?? req.body ?? {};
    const snapshot = updateRemoteSupportFlags(patch, runtimeActor(req));
    if (!snapshot.flags.screenFeedEnabled) {
      watcherPollStore.clear();
      screenFeedCursorStore.clear();
      screenFeedFailureStore.clear();
    }
    if (!snapshot.flags.screenFeedEnabled || !snapshot.flags.fastScreenFeed) screenFeedLiveHub.disconnectAll();
    if (!snapshot.flags.remoteControl) stopAllRemoteControlSessions("runtime-disabled");
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  });

  app.post("/api/screen-feed/admin/runtime/emergency-stop", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    watcherPollStore.clear();
    screenFeedCursorStore.clear();
    screenFeedFailureStore.clear();
    screenFeedLiveHub.disconnectAll();
    stopAllRemoteControlSessions("global-emergency-stop");
    const snapshot = emergencyDisableRemoteSupport(runtimeActor(req));
    logger.warn(`[RemoteSupport] emergency stop activated by ${runtimeActor(req)}`);
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  });

  app.post("/api/screen-feed/admin/runtime/restore-defaults", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    stopAllRemoteControlSessions("runtime-defaults-restored");
    const snapshot = restoreRemoteSupportBootDefaults(runtimeActor(req));
    res.setHeader("Cache-Control", "no-store");
    res.json(snapshot);
  });

  app.post("/api/screen-feed/admin/runtime/reset-metrics", requireAuth, (req, res) => {
    if (!requireDeveloper(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    res.json(resetRemoteSupportMetrics());
  });

  app.get("/api/screen-feed/capabilities", requireAuth, viewPermission, (req, res) => {
    if (!requireSupportController(req, res)) return;
    res.setHeader("Cache-Control", "no-store");
    const screenFeedEnabled = isRemoteSupportEnabled("screenFeedEnabled");
    res.json({
      flags: {
        screenFeedEnabled,
        fastScreenFeed: screenFeedEnabled && isRemoteSupportEnabled("fastScreenFeed"),
        remoteControl: screenFeedEnabled && isRemoteSupportEnabled("remoteControl"),
        keyboardControl: screenFeedEnabled && isRemoteSupportEnabled("keyboardControl"),
      },
    });
  });

  // Legacy SSE recovery only. Normal status delivery is tab-scoped WebSocket.
  app.get("/api/screen-feed/live/status", requireLogin, (req, res) => {
    if (!isRemoteSupportEnabled("screenFeedEnabled") || !isRemoteSupportEnabled("fastScreenFeed")) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    }
    const userId = String(getSessionUserId(req));
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(userId, tabId);
    const wantsEventStream = String(req.headers.accept ?? "").toLowerCase().includes("text/event-stream");
    if (!wantsEventStream) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ watched: isFeedBeingWatched(userId, tabId), fast: true, tabId });
    }
    openEventStream(res);
    recordRemoteSupportMetric("liveStatusConnected");
    const sendStatus = () => writeEvent(res, "status", { watched: isFeedBeingWatched(userId, tabId), fast: true, tabId });
    const unsubscribeStatus = screenFeedLiveHub.subscribeStatus(key, sendStatus);
    let unsubscribeDisconnect = () => {};
    let closed = false;
    const refreshId = setInterval(sendStatus, LIVE_STATUS_REFRESH_MS);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(refreshId);
      unsubscribeStatus();
      unsubscribeDisconnect();
      if (!res.writableEnded) res.end();
    };
    unsubscribeDisconnect = screenFeedLiveHub.subscribeDisconnect(cleanup);
    req.once("close", cleanup);
    res.once("close", cleanup);
    sendStatus();
  });

  app.get("/api/screen-feed/live/:userId", requireAuth, viewPermission, async (req, res) => {
    if (!requireSupportController(req, res)) return;
    if (!isRemoteSupportEnabled("screenFeedEnabled") || !isRemoteSupportEnabled("fastScreenFeed")) {
      res.setHeader("Cache-Control", "no-store");
      return res.status(204).end();
    }

    const watchedUserId = req.params.userId;
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(watchedUserId, tabId);
    const access = await authorizeFrameAccess(req, res, watchedUserId);
    if (!access) return;

    openEventStream(res);
    recordRemoteSupportMetric("liveViewerConnected");
    watcherPollStore.set(key, Date.now());

    const frame = screenFeedStore.get(key);
    void beginScreenWatch({
      companyId: access.companyId,
      controllerUserId: access.actor.userId,
      controllerUsername: access.actor.username,
      controllerRole: access.actor.role,
      targetUserId: watchedUserId,
      targetUsername: frame?.username,
    });

    const unsubscribeFrames = screenFeedLiveHub.subscribeFrames(key, (nextFrame) => {
      writeEvent(res, "frame", serializeFrame(nextFrame, screenFeedFailureStore.get(key)));
    });
    const unsubscribeCursors = screenFeedLiveHub.subscribeCursors(key, (cursor) => writeEvent(res, "cursor", serializeCursor(cursor)));
    const unsubscribeFailures = screenFeedLiveHub.subscribeFailures(key, (failure) => writeEvent(res, "capture-failure", serializeFailure(failure)));
    let unsubscribeDisconnect = () => {};
    let closed = false;

    const heartbeatId = setInterval(() => {
      watcherPollStore.set(key, Date.now());
      void beginScreenWatch({
        companyId: access.companyId,
        controllerUserId: access.actor.userId,
        controllerUsername: access.actor.username,
        controllerRole: access.actor.role,
        targetUserId: watchedUserId,
        targetUsername: screenFeedStore.get(key)?.username,
      });
      writeHeartbeat(res);
    }, LIVE_HEARTBEAT_MS);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeatId);
      unsubscribeFrames();
      unsubscribeCursors();
      unsubscribeFailures();
      unsubscribeDisconnect();
      void endScreenWatch({
        controllerUserId: access.actor.userId,
        targetUserId: watchedUserId,
        stopReason: "live-viewer-closed",
      });
      if (!screenFeedLiveHub.hasViewer(key)) {
        watcherPollStore.delete(key);
        screenFeedLiveHub.notifyStatus(key);
      }
      if (!res.writableEnded) res.end();
    };

    unsubscribeDisconnect = screenFeedLiveHub.subscribeDisconnect(cleanup);
    req.once("close", cleanup);
    res.once("close", cleanup);
    writeEvent(res, "ready", { userId: watchedUserId, tabId });
    const currentFrame = screenFeedStore.get(key);
    const currentFailure = screenFeedFailureStore.get(key);
    if (currentFrame) writeEvent(res, "frame", serializeFrame(currentFrame, currentFailure));
    if (currentFailure) writeEvent(res, "capture-failure", serializeFailure(currentFailure));
    const currentCursor = screenFeedCursorStore.get(key);
    if (currentCursor) writeEvent(res, "cursor", serializeCursor(currentCursor));
  });

  app.get("/api/screen-feed/being-watched", requireLogin, (req, res) => {
    recordRemoteSupportMetric("watcherStatusPoll");
    if (!isRemoteSupportEnabled("screenFeedEnabled")) return res.json({ watched: false, fast: false });
    const userId = String(getSessionUserId(req));
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(userId, tabId);
    const lastPoll = watcherPollStore.get(key) ?? 0;
    const ageMs = Date.now() - lastPoll;
    const watched = isFeedBeingWatched(userId, tabId);
    if (isDev) {
      logger.info(
        `[ScreenFeed] being-watched userId=${userId} tabId=${tabId} watched=${watched} lastPollAgeMs=${lastPoll > 0 ? ageMs : "never"}`
      );
    }
    res.json({
      watched,
      fast: isRemoteSupportEnabled("fastScreenFeed"),
      tabId,
      ...(isDev ? { userId, lastWatcherPollAgeMs: lastPoll > 0 ? ageMs : null } : {}),
    });
  });

  app.get("/api/screen-feed/trace/:event", requireLogin, (req, res) => {
    if (!isDev) return res.status(204).end();
    const userId = String(getSessionUserId(req));
    const event = req.params.event;
    const extra = req.query.d ? String(req.query.d) : "";
    logger.info(`[ScreenFeed][TRACE] userId=${userId} event=${event}${extra ? " d=" + extra : ""}`);
    res.status(204).end();
  });

  app.post("/api/screen-feed/pointer", requireLogin, (req, res) => {
    if (!isRemoteSupportEnabled("screenFeedEnabled")) return res.status(204).end();
    const userId = String(getSessionUserId(req));
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(userId, tabId);
    if (!isFeedBeingWatched(userId, tabId)) return res.status(204).end();

    if (recordCaptureFailure(userId, tabId, req.body?.failure)) return res.status(204).end();
    const cursor = sanitizeScreenFeedCursor(req.body?.cursor ?? req.body);
    if (!cursor) return res.status(204).end();
    screenFeedCursorStore.set(key, cursor);
    const existingFrame = screenFeedStore.get(key);
    if (existingFrame) existingFrame.cursor = cursor;
    if (isRemoteSupportEnabled("fastScreenFeed")) screenFeedLiveHub.publishCursor(key, cursor);
    res.status(204).end();
  });

  // Legacy JSON/base64 upload is retained only as a recovery endpoint for old
  // clients. Current clients never enter this route; they use binary /ws frames.
  app.post("/api/screen-feed", requireLogin, (req, res) => {
    if (!isRemoteSupportEnabled("screenFeedEnabled")) return res.status(200).end();
    const userId = String(getSessionUserId(req));
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(userId, tabId);
    if (isDev) {
      logger.info(`[ScreenFeed] legacy POST received userId=${userId} tabId=${tabId}`);
    }
    const { dataUrl, clicks, cursor, viewport, capture, clientCapturedAt } = req.body ?? {};
    if (!isValidScreenFeedDataUrl(dataUrl)) {
      recordRemoteSupportMetric("frameRejected");
      logger.warn(`[ScreenFeed] legacy frame rejected userId=${userId} tabId=${tabId} reason=invalid-data-url`);
      return res.status(400).end();
    }
    if (dataUrl.length > MAX_FRAME_SIZE) {
      recordRemoteSupportMetric("frameRejected");
      return res.status(204).end();
    }
    const receivedAt = new Date();
    const username = getSessionUsername(req) || userId;
    const safeClicks = sanitizeScreenFeedClicks(clicks, receivedAt.getTime());
    const safeCursor = sanitizeScreenFeedCursor(cursor, receivedAt.getTime()) ?? screenFeedCursorStore.get(key) ?? null;
    const safeCapture = sanitizeScreenFeedCapture(capture);
    const frame: ScreenFrame = {
      dataUrl,
      capturedAt: receivedAt,
      clientCapturedAt: sanitizeScreenFeedClientCapturedAt(clientCapturedAt, receivedAt.getTime()),
      userId,
      username,
      tabId,
      clicks: safeClicks,
      cursor: safeCursor,
      viewport: sanitizeScreenFeedViewport(viewport),
      capture: safeCapture,
    };
    screenFeedStore.set(key, frame);
    screenFeedFailureStore.delete(key);
    if (safeCursor) screenFeedCursorStore.set(key, safeCursor);
    recordRemoteSupportMetric("frameAccepted", Buffer.byteLength(dataUrl, "utf8"));
    if (isRemoteSupportEnabled("fastScreenFeed")) {
      const pushed = screenFeedLiveHub.publishFrame(key, frame);
      if (pushed > 0) recordRemoteSupportMetric("framePushed", pushed);
    }
    res.status(204).end();
  });

  app.get("/api/screen-feed/:userId", requireAuth, viewPermission, async (req, res) => {
    if (!requireSupportController(req, res)) return;
    recordRemoteSupportMetric("viewerPoll");
    res.setHeader("Cache-Control", "no-store");
    if (!isRemoteSupportEnabled("screenFeedEnabled")) return res.json(null);
    const watchedUserId = req.params.userId;
    const tabId = requestTabId(req);
    const key = screenFeedStoreKey(watchedUserId, tabId);
    const access = await authorizeFrameAccess(req, res, watchedUserId);
    if (!access) return;

    watcherPollStore.set(key, Date.now());
    screenFeedLiveHub.notifyStatus(key);
    const frame = screenFeedStore.get(key);
    const failure = screenFeedFailureStore.get(key);
    if (isDev) {
      const frameAgeMs = frame ? Date.now() - frame.capturedAt.getTime() : null;
      logger.info(`[ScreenFeed] legacy GET userId=${watchedUserId} tabId=${tabId} hasFrame=${!!frame} frameAgeMs=${frameAgeMs}`);
    }

    void beginScreenWatch({
      companyId: access.companyId,
      controllerUserId: access.actor.userId,
      controllerUsername: access.actor.username,
      controllerRole: access.actor.role,
      targetUserId: watchedUserId,
      targetUsername: frame?.username,
    });

    if (!frame) return res.json(failure ? { captureFailure: serializeFailure(failure), tabId } : null);
    const latestCursor = screenFeedCursorStore.get(key);
    if (latestCursor) frame.cursor = latestCursor;
    res.json(serializeFrame(frame, failure));
  });
}
