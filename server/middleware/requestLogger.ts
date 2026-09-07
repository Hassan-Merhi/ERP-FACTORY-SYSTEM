/**
 * HTTP request logging and lightweight internal monitoring middleware.
 * Logs failures, slow requests, client disconnects and an optional sample of successful requests.
 * Never logs request/response bodies, credentials, cookies or auth headers.
 */
import { randomUUID } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { pool } from "../db";
import { logger } from "../lib/logger";
import { getExpectedClientResponseCode } from "../lib/expectedClientResponse";
import { getOperationalEventSnapshot, recordOperationalEvent } from "../lib/operationalEvents";
import { handlePerformanceDashboard, recordPerformanceSample } from "../lib/performanceDashboard";
import {
  classifyRequestTiming,
  getSlowRequestThresholdConfig,
  getSlowRequestThresholdMs,
} from "../lib/requestLoggingPolicy";
import { getRequestPerformanceMetrics, runWithRequestPerformanceContext } from "../lib/requestPerformanceContext";
import { normaliseRouteTemplate, runWithTraceContext, updateTraceContext } from "../lib/traceContext";
import { writeSuccessfulActivityAudit } from "./activityAudit";
import { getBandwidthDiagnosticSnapshot } from "./bandwidthDebug";
import { handleClientObservability } from "./clientObservability";

const SUCCESS_SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.REQUEST_LOG_SAMPLE_RATE || 0)));
const CLIENT_ABORT_STATUS = 499;
const SKIPPED_PATHS = new Set([
  "/api/auth/me",
  "/api/health",
  "/api/health/db",
  "/api/health/metrics",
  "/api/health/performance",
  "/api/health/performance.json",
  "/api/boot",
  "/api/csrf-token",
]);
const startedAt = Date.now();

type DurationBucket = "under100" | "under500" | "under1000" | "under5000" | "over5000";
type RequestCompletionKind = "finished" | "aborted" | "stream_closed";

interface RequestMetrics {
  total: number;
  active: number;
  success: number;
  expectedClientResponse: number;
  clientError: number;
  clientAbort: number;
  streamClosed: number;
  serverError: number;
  slow: number;
  durationTotalMs: number;
  durationMaxMs: number;
  dbQueryCount: number;
  dbDurationMs: number;
  durationBuckets: Record<DurationBucket, number>;
}

const metrics: RequestMetrics = {
  total: 0,
  active: 0,
  success: 0,
  expectedClientResponse: 0,
  clientError: 0,
  clientAbort: 0,
  streamClosed: 0,
  serverError: 0,
  slow: 0,
  durationTotalMs: 0,
  durationMaxMs: 0,
  dbQueryCount: 0,
  dbDurationMs: 0,
  durationBuckets: { under100: 0, under500: 0, under1000: 0, under5000: 0, over5000: 0 },
};

function normaliseRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[A-Za-z0-9._:-]{8,128}$/.test(trimmed) ? trimmed : undefined;
}

function recordDuration(durationMs: number): void {
  metrics.durationTotalMs += durationMs;
  metrics.durationMaxMs = Math.max(metrics.durationMaxMs, durationMs);
  if (durationMs < 100) metrics.durationBuckets.under100 += 1;
  else if (durationMs < 500) metrics.durationBuckets.under500 += 1;
  else if (durationMs < 1000) metrics.durationBuckets.under1000 += 1;
  else if (durationMs < 5000) metrics.durationBuckets.under5000 += 1;
  else metrics.durationBuckets.over5000 += 1;
}

function percentage(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 10000) / 100;
}

function isMonitoringRole(req: Request): boolean {
  const role = String(req.session?.currentRole || req.user?.role || "").toLowerCase();
  return role === "admin" || role === "developer";
}

function isExpectedLongLivedStream(req: Request, res: Response): boolean {
  const accept = String(req.headers.accept || "").toLowerCase();
  const contentType = String(res.getHeader?.("content-type") || "").toLowerCase();
  return accept.includes("text/event-stream") || contentType.includes("text/event-stream");
}

export function resetRequestMetricsForTests(): void {
  metrics.total = 0;
  metrics.active = 0;
  metrics.success = 0;
  metrics.expectedClientResponse = 0;
  metrics.clientError = 0;
  metrics.clientAbort = 0;
  metrics.streamClosed = 0;
  metrics.serverError = 0;
  metrics.slow = 0;
  metrics.durationTotalMs = 0;
  metrics.durationMaxMs = 0;
  metrics.dbQueryCount = 0;
  metrics.dbDurationMs = 0;
  metrics.durationBuckets.under100 = 0;
  metrics.durationBuckets.under500 = 0;
  metrics.durationBuckets.under1000 = 0;
  metrics.durationBuckets.under5000 = 0;
  metrics.durationBuckets.over5000 = 0;
}

export function getRequestMetricsSnapshot() {
  const memory = process.memoryUsage();
  const poolMax = Number(pool.options?.max || 0);
  const poolTotal = Number(pool.totalCount || 0);
  const poolIdle = Number(pool.idleCount || 0);
  const poolWaiting = Number(pool.waitingCount || 0);
  const resolved = metrics.success + metrics.expectedClientResponse + metrics.clientError + metrics.serverError;
  const measuredCompleted = resolved + metrics.clientAbort;
  const completed = measuredCompleted + metrics.streamClosed;
  const slowRequestThresholdsMs = getSlowRequestThresholdConfig();

  return {
    status: poolWaiting > 0 ? "degraded" : "ok",
    timestamp: new Date().toISOString(),
    process: {
      uptimeSeconds: Math.floor(process.uptime()),
      startedAt: new Date(startedAt).toISOString(),
      nodeEnv: process.env.NODE_ENV || "development",
      memoryMb: {
        rss: Math.round(memory.rss / 1024 / 1024),
        heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
        heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      },
    },
    requests: {
      total: metrics.total,
      active: metrics.active,
      completed,
      measuredCompleted,
      success: metrics.success,
      expectedClientResponse: metrics.expectedClientResponse,
      clientError: metrics.clientError,
      clientAbort: metrics.clientAbort,
      streamClosed: metrics.streamClosed,
      serverError: metrics.serverError,
      slow: metrics.slow,
      averageDurationMs: measuredCompleted > 0 ? Math.round(metrics.durationTotalMs / measuredCompleted) : 0,
      maxDurationMs: metrics.durationMaxMs,
      slowPercent: percentage(metrics.slow, measuredCompleted),
      clientAbortPercent: percentage(metrics.clientAbort, measuredCompleted),
      serverErrorPercent: percentage(metrics.serverError, resolved),
      slowRequestThresholdMs: slowRequestThresholdsMs.default,
      slowRequestThresholdsMs,
      durationBuckets: { ...metrics.durationBuckets },
      database: {
        queryCount: metrics.dbQueryCount,
        totalDurationMs: Math.round(metrics.dbDurationMs),
        averageQueriesPerRequest:
          measuredCompleted > 0 ? Math.round((metrics.dbQueryCount / measuredCompleted) * 100) / 100 : 0,
        averageDurationMsPerRequest:
          measuredCompleted > 0 ? Math.round(metrics.dbDurationMs / measuredCompleted) : 0,
      },
    },
    databasePool: {
      max: poolMax,
      total: poolTotal,
      idle: poolIdle,
      active: Math.max(0, poolTotal - poolIdle),
      waiting: poolWaiting,
      utilizationPercent: poolMax > 0 ? Math.round(((poolTotal - poolIdle) / poolMax) * 100) : null,
    },
    bandwidth: getBandwidthDiagnosticSnapshot(),
    operationalEvents: getOperationalEventSnapshot(),
  };
}

export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = Date.now();
  const requestId = normaliseRequestId(req.headers["x-request-id"]) || randomUUID();
  const session = req.session;
  const initialCompanyId = Number(session?.currentCompanyId) || undefined;
  const initialFactoryCompanyId = Number(session?.factoryCompanyId) || undefined;
  const initialLocationId = Number(session?.currentLocationId) || undefined;
  const initialUserId = session?.userId || req.user?.id;
  const buildVersion = process.env.BUILD_VERSION || process.env.RENDER_GIT_COMMIT?.substring(0, 8) || "dev";
  let responseBytes = 0;

  (req as unknown as { requestId: string }).requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  const originalWrite = res.write.bind(res);
  (res as typeof res & { write: typeof res.write }).write = function (chunk, ...args: any[]): boolean {
    if (chunk != null) responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return originalWrite(chunk, ...args);
  };
  const originalEnd = res.end.bind(res);
  (res as typeof res & { end: typeof res.end }).end = function (chunk?, ...args: any[]): Response {
    if (chunk != null && typeof chunk !== "function")
      responseBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    return originalEnd(chunk, ...args);
  };

  runWithTraceContext(
    {
      requestId,
      userId: initialUserId,
      companyId: initialCompanyId,
      factoryCompanyId: initialFactoryCompanyId,
      locationId: initialLocationId,
      buildVersion,
      source: "http",
    },
    () =>
      runWithRequestPerformanceContext(() => {
        if (handleClientObservability(req, res, requestId)) return;
        if (handlePerformanceDashboard(req, res)) return;

        if (req.method === "GET" && req.path === "/api/health") {
          res
            .status(200)
            .json({ status: "ok", timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()) });
          return;
        }

        if (req.method === "GET" && req.path === "/api/health/metrics") {
          if (!isMonitoringRole(req)) {
            res.status(403).json({ message: "Admin or Developer access required." });
            return;
          }
          res.status(200).json(getRequestMetricsSnapshot());
          return;
        }

        if (req.method === "GET" && req.path === "/api/audit-log") {
          const companyId = Number(req.session?.currentCompanyId);
          if (!Number.isSafeInteger(companyId) || companyId <= 0) {
            res
              .status(409)
              .json({ message: "Select a company before viewing activity history.", code: "AUDIT_COMPANY_REQUIRED" });
            return;
          }
        }

        if (req.path.startsWith("/api/")) {
          metrics.total += 1;
          metrics.active += 1;
        }

        let finalized = false;
        const finalizeRequest = (completionKind: RequestCompletionKind) => {
          const { method, path } = req;
          if (finalized || !path.startsWith("/api/")) return;
          finalized = true;

          metrics.active = Math.max(0, metrics.active - 1);
          if (completionKind === "stream_closed") {
            metrics.streamClosed += 1;
            return;
          }

          const aborted = completionKind === "aborted";
          const statusCode = aborted ? CLIENT_ABORT_STATUS : res.statusCode;
          const durationMs = Date.now() - start;
          const routeTemplate = normaliseRouteTemplate(path, req.route?.path, req.baseUrl || "");
          const databaseMetrics = getRequestPerformanceMetrics();
          const currentSession = req.session;
          const userId = currentSession?.userId || req.user?.id;
          const companyId = Number(currentSession?.currentCompanyId) || undefined;
          const factoryCompanyId = Number(currentSession?.factoryCompanyId) || undefined;
          const locationId = Number(currentSession?.currentLocationId) || undefined;
          const timingClass = classifyRequestTiming(routeTemplate);
          const slowRequestThresholdMs = getSlowRequestThresholdMs(routeTemplate);
          const expectedClientResponseCode = aborted ? undefined : getExpectedClientResponseCode(res);

          updateTraceContext({ routeTemplate, userId, companyId, factoryCompanyId, locationId });
          recordDuration(durationMs);
          metrics.dbQueryCount += databaseMetrics.dbQueryCount;
          metrics.dbDurationMs += databaseMetrics.dbDurationMs;
          recordPerformanceSample({
            method,
            routeTemplate,
            status: statusCode,
            durationMs,
            responseBytes,
            dbQueryCount: databaseMetrics.dbQueryCount,
            dbDurationMs: databaseMetrics.dbDurationMs,
          });
          if (!aborted) writeSuccessfulActivityAudit(req, statusCode);

          if (aborted) metrics.clientAbort += 1;
          else if (statusCode >= 500) metrics.serverError += 1;
          else if (expectedClientResponseCode) metrics.expectedClientResponse += 1;
          else if (statusCode >= 400) metrics.clientError += 1;
          else metrics.success += 1;

          const isSlow = durationMs >= slowRequestThresholdMs;
          if (isSlow) metrics.slow += 1;

          if (aborted) {
            logger.warn("Client disconnected before response completed", {
              module: "http",
              action: "client_abort",
              requestId,
              routeTemplate,
              ...(userId != null ? { userId } : {}),
              ...(companyId != null ? { companyId } : {}),
              ...(factoryCompanyId != null ? { factoryCompanyId } : {}),
              ...(locationId != null ? { locationId } : {}),
              status: CLIENT_ABORT_STATUS,
              durationMs,
              responseBytes,
              dbQueryCount: databaseMetrics.dbQueryCount,
              dbDurationMs: Math.round(databaseMetrics.dbDurationMs),
              slow: isSlow,
              thresholdMs: slowRequestThresholdMs,
              thresholdClass: timingClass,
              responseStarted: res.headersSent,
            });
            return;
          }

          if (statusCode >= 500) {
            recordOperationalEvent({
              category: "error",
              code: "http_server_error",
              severity: "critical",
              message: "HTTP server error detected",
              requestId,
              method,
              path: routeTemplate,
              status: statusCode,
              durationMs,
              responseBytes,
              dbQueryCount: databaseMetrics.dbQueryCount,
              dbDurationMs: databaseMetrics.dbDurationMs,
              ...(userId != null ? { userId: Number(userId) } : {}),
              ...(companyId != null ? { companyId } : {}),
            });
            return;
          }

          if (SKIPPED_PATHS.has(path)) return;
          const isFailure = statusCode >= 400 && !expectedClientResponseCode;
          const sampledSuccess =
            !isFailure && !expectedClientResponseCode && SUCCESS_SAMPLE_RATE > 0 && Math.random() < SUCCESS_SAMPLE_RATE;
          if (!isFailure && !isSlow && !sampledSuccess && !expectedClientResponseCode) return;

          const level = expectedClientResponseCode ? "info" : statusCode >= 400 || isSlow ? "warn" : "info";
          const message = expectedClientResponseCode
            ? "Request requires an expected client confirmation"
            : `${method} ${routeTemplate} ${statusCode}`;
          const action = expectedClientResponseCode
            ? `expected_client_response.${expectedClientResponseCode}`
            : isSlow
              ? "slow_request"
              : "request";
          logger[level](message, {
            module: "http",
            action,
            requestId,
            routeTemplate,
            ...(userId != null ? { userId } : {}),
            ...(companyId != null ? { companyId } : {}),
            ...(factoryCompanyId != null ? { factoryCompanyId } : {}),
            ...(locationId != null ? { locationId } : {}),
            status: statusCode,
            durationMs,
            responseBytes,
            dbQueryCount: databaseMetrics.dbQueryCount,
            dbDurationMs: Math.round(databaseMetrics.dbDurationMs),
            slow: isSlow,
            thresholdMs: slowRequestThresholdMs,
            thresholdClass: timingClass,
            ...(expectedClientResponseCode ? { expectedClientResponseCode } : {}),
          });
        };

        res.on("finish", () => finalizeRequest("finished"));
        res.on("close", () => {
          if (res.writableFinished) return;
          finalizeRequest(isExpectedLongLivedStream(req, res) ? "stream_closed" : "aborted");
        });

        next();
      })
  );
}
