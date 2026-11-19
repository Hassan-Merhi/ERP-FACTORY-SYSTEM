// Extracted from ./screenFeedRoutes.ts
import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { logger } from "../lib/logger";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getSessionUserId } from "../lib/requestContext";
import {
  screenFeedCursorStore,
  screenFeedFailureStore,
  screenFeedStore,
  screenFeedStoreKey,
  watcherPollStore,
} from "../screenFeedStore";
import { stopAllRemoteControlSessions } from "../services/remoteControlSessionService";
import { getRemoteSupportCommandAuditHealth } from "../services/remoteSupportCommandAuditQueue";
import { screenFeedLiveHub } from "../services/screenFeedLiveHub";
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
import {
  LIVE_STATUS_REFRESH_MS,
  LIVE_HEARTBEAT_MS,
  requireDeveloper,
  requireSupportController,
  runtimeActor,
  requestTabId,
  authorizeFrameAccess,
  openEventStream,
  writeEvent,
  writeHeartbeat,
  isFeedBeingWatched,
  serializeCursor,
  serializeFailure,
  serializeFrame,
} from "./screenFeedRoutesHelpers";

export const viewPermission = requireActionAccess("remote_support_view");

export function registerScreenFeedRoutesPart1(app: Express) {
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
    const wantsEventStream = String(req.headers.accept ?? "")
      .toLowerCase()
      .includes("text/event-stream");
    if (!wantsEventStream) {
      res.setHeader("Cache-Control", "no-store");
      return res.json({ watched: isFeedBeingWatched(userId, tabId), fast: true, tabId });
    }
    openEventStream(res);
    recordRemoteSupportMetric("liveStatusConnected");
    const sendStatus = () =>
      writeEvent(res, "status", { watched: isFeedBeingWatched(userId, tabId), fast: true, tabId });
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
    const unsubscribeCursors = screenFeedLiveHub.subscribeCursors(key, (cursor) =>
      writeEvent(res, "cursor", serializeCursor(cursor))
    );
    const unsubscribeFailures = screenFeedLiveHub.subscribeFailures(key, (failure) =>
      writeEvent(res, "capture-failure", serializeFailure(failure))
    );
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
}
