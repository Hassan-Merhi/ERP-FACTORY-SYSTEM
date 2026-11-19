import type { Express } from "express";
import { requireAuth, requireLogin } from "../auth";
import { logger } from "../lib/logger";
import { getSessionUserId, getSessionUsername } from "../lib/requestContext";
import {
  screenFeedCursorStore,
  screenFeedFailureStore,
  screenFeedStore,
  screenFeedStoreKey,
  watcherPollStore,
  type ScreenFrame,
} from "../screenFeedStore";
import { screenFeedLiveHub } from "../services/screenFeedLiveHub";
import {
  isValidScreenFeedDataUrl,
  sanitizeScreenFeedCapture,
  sanitizeScreenFeedClicks,
  sanitizeScreenFeedClientCapturedAt,
  sanitizeScreenFeedCursor,
  sanitizeScreenFeedViewport,
} from "../services/screenFeedService";
import { beginScreenWatch } from "../services/screenWatchAuditService";
import { isRemoteSupportEnabled, recordRemoteSupportMetric } from "../services/remoteSupportRuntime";
import {
  MAX_FRAME_SIZE,
  requireSupportController,
  requestTabId,
  authorizeFrameAccess,
  isFeedBeingWatched,
  serializeFailure,
  serializeFrame,
  recordCaptureFailure,
} from "./screenFeedRoutesHelpers";
import { registerScreenFeedRoutesPart1, viewPermission } from "./registerScreenFeedRoutesPart1";

const isDev = process.env.NODE_ENV !== "production";

export function registerScreenFeedRoutes(app: Express) {
  registerScreenFeedRoutesPart1(app);

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
      logger.info(
        `[ScreenFeed] legacy GET userId=${watchedUserId} tabId=${tabId} hasFrame=${!!frame} frameAgeMs=${frameAgeMs}`
      );
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
