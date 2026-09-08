import { createHash } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { getSessionUserId } from "../lib/requestContext";
import { isRemoteSupportEnabled, recordRemoteSupportMetric } from "../services/remoteSupportRuntime";

const FAST_MAX_FRAME_SIZE = 900_000;
const LEGACY_MAX_FRAME_SIZE = 1_500_000;
const FAST_MIN_UPLOAD_INTERVAL_MS = 650;
const FAST_RETRY_AFTER_SECONDS = 1;
const MAX_USER_ID_LENGTH = 64;
const MIN_RECONNECT_DELAY_MS = 2_500;
const MAX_RECONNECT_JITTER_MS = 2_000;

const lastFastUploadAt = new Map<string, number>();

function requestPath(req: Request): string {
  return req.originalUrl.split("?", 1)[0] ?? req.path;
}

function isValidWatchedUserId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_USER_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(value);
}

function reconnectDelay(): number {
  return MIN_RECONNECT_DELAY_MS + Math.floor(Math.random() * (MAX_RECONNECT_JITTER_MS + 1));
}

function frameEtag(userId: string, frame: any): string {
  const latestClickTs = Array.isArray(frame?.clicks)
    ? frame.clicks.reduce((latest: number, click: any) => Math.max(latest, Number(click?.ts) || 0), 0)
    : 0;
  const identity = [
    userId,
    frame?.capturedAt ?? "",
    typeof frame?.dataUrl === "string" ? frame.dataUrl.length : 0,
    Number(frame?.cursor?.ts) || 0,
    latestClickTs,
    Number(frame?.capture?.encodedBytes) || 0,
    frame?.captureFailure?.occurredAt ?? "",
    frame?.captureFailure?.stage ?? "",
    frame?.captureFailure?.reason ?? "",
  ].join(":");
  const digest = createHash("sha256").update(identity).digest("hex");
  return `W/"screen-feed-${digest}"`;
}

function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return false;
  return value
    .split(",")
    .map((candidate) => candidate.trim())
    .some((candidate) => candidate === "*" || candidate === etag);
}

function installReconnectJitter(res: Response): void {
  const originalWrite = res.write.bind(res) as (...args: any[]) => boolean;
  let retryRewritten = false;
  res.write = ((chunk, ...args) => {
    if (!retryRewritten && typeof chunk === "string" && chunk.includes("retry: 3000")) {
      retryRewritten = true;
      chunk = chunk.replace("retry: 3000", `retry: ${reconnectDelay()}`);
    }
    return originalWrite(chunk, ...args);
  }) as typeof res.write;
}

function installConditionalFrameResponse(req: Request, res: Response, watchedUserId: string): void {
  const originalJson = res.json.bind(res);
  res.json = ((body) => {
    const fastEnabled = isRemoteSupportEnabled("fastScreenFeed");
    res.setHeader("X-Screen-Feed-Transport", fastEnabled ? "fast" : "legacy");

    if (!body || typeof body !== "object" || typeof body.dataUrl !== "string") {
      res.setHeader("Cache-Control", "no-store");
      return originalJson(body);
    }

    const etag = frameEtag(watchedUserId, body);
    res.setHeader("Cache-Control", "private, no-cache, must-revalidate");
    res.setHeader("ETag", etag);

    if (fastEnabled && matchesEtag(req.headers["if-none-match"], etag)) {
      return res.status(304).end();
    }

    return originalJson(body);
  }) as typeof res.json;
}

function clearTransportPressureState(pathname: string, method: string): void {
  const runtimeMutation =
    (method === "PATCH" && pathname === "/api/screen-feed/admin/runtime") ||
    (method === "POST" &&
      ["/api/screen-feed/admin/runtime/emergency-stop", "/api/screen-feed/admin/runtime/restore-defaults"].includes(
        pathname
      ));
  if (runtimeMutation) lastFastUploadAt.clear();
}

function enforceUploadPressure(req: Request, res: Response, next: NextFunction): void {
  const userId = getSessionUserId(req);
  const fastEnabled = isRemoteSupportEnabled("fastScreenFeed");
  const dataUrl = req.body?.dataUrl;
  const activeLimit = fastEnabled ? FAST_MAX_FRAME_SIZE : LEGACY_MAX_FRAME_SIZE;

  if (typeof dataUrl === "string" && dataUrl.length > activeLimit) {
    recordRemoteSupportMetric("frameRejected");
    res.status(413).json({ message: "Frame payload is too large." });
    return;
  }

  if (!fastEnabled) {
    next();
    return;
  }

  const now = Date.now();
  const previous = lastFastUploadAt.get(userId) ?? 0;
  if (now - previous < FAST_MIN_UPLOAD_INTERVAL_MS) {
    recordRemoteSupportMetric("frameRejected");
    res.setHeader("Retry-After", String(FAST_RETRY_AFTER_SECONDS));
    res.status(429).json({ message: "Frame producer is sending too quickly." });
    return;
  }

  lastFastUploadAt.set(userId, now);
  res.once("finish", () => {
    if (res.statusCode >= 400 && lastFastUploadAt.get(userId) === now) {
      lastFastUploadAt.delete(userId);
    }
  });
  next();
}

export function registerScreenFeedTransportHardening(app: Express): void {
  app.use("/api/screen-feed", (req, res, next) => {
    const pathname = requestPath(req);
    clearTransportPressureState(pathname, req.method);

    if (req.method === "GET" && /^\/api\/screen-feed\/live(?:\/|$)/.test(pathname)) {
      installReconnectJitter(res);
      return next();
    }

    if (req.method === "GET") {
      const match = pathname.match(/^\/api\/screen-feed\/([^/]+)$/);
      if (match) {
        let watchedUserId: string;
        try {
          watchedUserId = decodeURIComponent(match[1]);
        } catch {
          return res.status(400).json({ message: "Invalid watched user ID." });
        }
        if (!isValidWatchedUserId(watchedUserId)) {
          return res.status(400).json({ message: "Invalid watched user ID." });
        }
        installConditionalFrameResponse(req, res, watchedUserId);
      }
      return next();
    }

    if (req.method === "POST" && pathname === "/api/screen-feed") {
      return enforceUploadPressure(req, res, next);
    }

    next();
  });
}

export function resetScreenFeedTransportHardeningForTests(): void {
  lastFastUploadAt.clear();
}
