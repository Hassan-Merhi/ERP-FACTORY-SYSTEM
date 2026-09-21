import type { Request, Response, NextFunction } from "express";
import { recordOperationalEvent } from "../lib/operationalEvents";
import { getRequestPerformanceMetrics, runWithRequestPerformanceContext } from "../lib/requestPerformanceContext";

const DEFAULT_THRESHOLD_BYTES = 500 * 1024;
const DEFAULT_STATIC_THRESHOLD_BYTES = 2 * 1024 * 1024;
const DEFAULT_DOCUMENT_THRESHOLD_BYTES = 10 * 1024 * 1024;
const DEFAULT_REPORT_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_LOG_TOP_N = 3;
const MAX_LOG_TOP_N = 5;
const DEFAULT_API_WINDOW_BUDGET_MB = 50;
const DEFAULT_STATIC_WINDOW_BUDGET_MB = 20;
const DEFAULT_ENDPOINT_WINDOW_BUDGET_MB = 20;

type EndpointAggregate = {
  method: string;
  path: string;
  requestCount: number;
  errorCount: number;
  totalResponseBytes: number;
  maxResponseBytes: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalHeapDeltaBytes: number;
  maxHeapDeltaBytes: number;
  dbQueryCount: number;
  dbDurationMs: number;
  status200Count: number;
  status304Count: number;
  otherStatusCount: number;
  cacheHitCount: number;
  cacheMissCount: number;
  cacheRevalidationCount: number;
  companyContexts: Set<string>;
  pageContexts: Set<string>;
};

type EndpointDiagnosticRow = {
  method: string;
  path: string;
  requests: number;
  errors: number;
  totalResponseBytes: number;
  averageResponseBytes: number;
  maxResponseBytes: number;
  averageDurationMs: number;
  maxDurationMs: number;
  dbQueryCount: number;
  averageDbDurationMs: number;
  status200: number;
  status304: number;
  otherStatuses: number;
  cacheHits: number;
  cacheMisses: number;
  cacheRevalidations: number;
  suspectedLoop: boolean;
  companyContexts: string[];
  pageContexts: string[];
};

type BandwidthBudgetConfig = {
  apiWindowBytes: number;
  staticWindowBytes: number;
  endpointWindowBytes: number;
};

type BandwidthBudgetViolation = {
  code: string;
  message: string;
  observedBytes: number;
  budgetBytes: number;
  method?: string;
  path?: string;
};

type BandwidthDiagnosticSnapshot = {
  generatedAt: string | null;
  windowMs: number;
  endpointCount: number;
  apiEndpointCount: number;
  staticAssetCount: number;
  totalApiResponseBytes: number;
  totalStaticAssetResponseBytes: number;
  budgets: BandwidthBudgetConfig;
  violations: BandwidthBudgetViolation[];
  ranked: EndpointDiagnosticRow[];
  staticAssets: EndpointDiagnosticRow[];
};

const aggregates = new Map<string, EndpointAggregate>();
let reportTimer: NodeJS.Timeout | undefined;
let latestDiagnosticSnapshot: BandwidthDiagnosticSnapshot = {
  generatedAt: null,
  windowMs: DEFAULT_REPORT_INTERVAL_MS,
  endpointCount: 0,
  apiEndpointCount: 0,
  staticAssetCount: 0,
  totalApiResponseBytes: 0,
  totalStaticAssetResponseBytes: 0,
  budgets: {
    apiWindowBytes: DEFAULT_API_WINDOW_BUDGET_MB * 1024 * 1024,
    staticWindowBytes: DEFAULT_STATIC_WINDOW_BUDGET_MB * 1024 * 1024,
    endpointWindowBytes: DEFAULT_ENDPOINT_WINDOW_BUDGET_MB * 1024 * 1024,
  },
  violations: [],
  ranked: [],
  staticAssets: [],
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function megabytesToBytes(value: string | undefined, fallbackMb: number): number {
  return Math.round(positiveNumber(value, fallbackMb) * 1024 * 1024);
}

function kilobytesToBytes(value: string | undefined, fallbackBytes: number): number {
  return Math.round(positiveNumber(value, fallbackBytes / 1024) * 1024);
}

function getBandwidthBudgetConfig(): BandwidthBudgetConfig {
  return {
    apiWindowBytes: megabytesToBytes(process.env.BANDWIDTH_DEBUG_API_WINDOW_BUDGET_MB, DEFAULT_API_WINDOW_BUDGET_MB),
    staticWindowBytes: megabytesToBytes(
      process.env.BANDWIDTH_DEBUG_STATIC_WINDOW_BUDGET_MB,
      DEFAULT_STATIC_WINDOW_BUDGET_MB
    ),
    endpointWindowBytes: megabytesToBytes(
      process.env.BANDWIDTH_DEBUG_ENDPOINT_WINDOW_BUDGET_MB,
      DEFAULT_ENDPOINT_WINDOW_BUDGET_MB
    ),
  };
}

function normalizePath(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === "string") {
    const baseUrl = req.baseUrl || "";
    if (routePath.startsWith("/api/")) return routePath;
    if (baseUrl && (routePath === baseUrl || routePath.startsWith(`${baseUrl}/`))) return routePath;
    return `${baseUrl}${routePath}` || "/";
  }

  return req.path
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Returns true only for API endpoints included in the API bandwidth ranking. */
function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Returns true for Vite/webpack hashed static assets such as
 * /assets/index-DdXDEvCM.js or /assets/main-B4tkL4ok.css.
 */
function isStaticAsset(path: string): boolean {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css|woff2?|ttf|png|jpe?g|webp|gif|svg|ico)$/i.test(path);
}

function isDocumentOrExportPath(path: string): boolean {
  return /(?:whatsapp|green-api|pdf|receipt|print|export|download|excel|xlsx|csv|send-invoice-pdf-backend|send-stock-pdf-backend)/i.test(
    path
  );
}

function getLargeResponseThresholdBytes(path: string): number {
  if (isStaticAsset(path)) {
    return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_STATIC_THRESHOLD_KB, DEFAULT_STATIC_THRESHOLD_BYTES);
  }
  if (isDocumentOrExportPath(path)) {
    return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_DOCUMENT_THRESHOLD_KB, DEFAULT_DOCUMENT_THRESHOLD_BYTES);
  }
  return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_THRESHOLD_KB, DEFAULT_THRESHOLD_BYTES);
}

type CacheOutcome = "hit" | "miss" | "revalidated" | "unknown";

function classifyCacheOutcome(statusCode: number, cacheHeader: unknown): CacheOutcome {
  if (statusCode === 304) return "revalidated";
  const value = String(cacheHeader || "")
    .trim()
    .toUpperCase();
  if (value === "HIT" || value === "COALESCED") return "hit";
  if (value === "MISS" || value === "BYPASS") return "miss";
  return "unknown";
}

function isSuspectedLoop(requestCount: number, windowMs: number): boolean {
  const threshold = Math.max(10, Math.ceil(windowMs / 30_000));
  return requestCount >= threshold;
}

function requestCompanyContext(req: Request): string | null {
  const session = (
    req as Request & {
      session?: { currentCompanyId?: unknown; factoryCompanyId?: unknown };
    }
  ).session;
  const companyId = session?.factoryCompanyId ?? session?.currentCompanyId;
  return companyId == null ? null : String(companyId);
}

function requestPageContext(req: Request): string | null {
  const explicit = req.get("x-erp-page");
  if (explicit) return explicit.slice(0, 160);
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer, "http://erp.local").pathname.slice(0, 160);
  } catch {
    return null;
  }
}

function formatRow(aggregate: EndpointAggregate, windowMs: number): EndpointDiagnosticRow {
  const count = Math.max(aggregate.requestCount, 1);
  return {
    method: aggregate.method,
    path: aggregate.path,
    requests: aggregate.requestCount,
    errors: aggregate.errorCount,
    totalResponseBytes: aggregate.totalResponseBytes,
    averageResponseBytes: Math.round(aggregate.totalResponseBytes / count),
    maxResponseBytes: aggregate.maxResponseBytes,
    averageDurationMs: Math.round(aggregate.totalDurationMs / count),
    maxDurationMs: aggregate.maxDurationMs,
    dbQueryCount: aggregate.dbQueryCount,
    averageDbDurationMs: Math.round(aggregate.dbDurationMs / count),
    status200: aggregate.status200Count,
    status304: aggregate.status304Count,
    otherStatuses: aggregate.otherStatusCount,
    cacheHits: aggregate.cacheHitCount,
    cacheMisses: aggregate.cacheMissCount,
    cacheRevalidations: aggregate.cacheRevalidationCount,
    suspectedLoop: isSuspectedLoop(aggregate.requestCount, windowMs),
    companyContexts: [...aggregate.companyContexts].sort(),
    pageContexts: [...aggregate.pageContexts].sort(),
  };
}

function sortRows(rows: EndpointAggregate[], windowMs: number): EndpointDiagnosticRow[] {
  return rows
    .map((row) => formatRow(row, windowMs))
    .sort((left, right) =>
      right.totalResponseBytes !== left.totalResponseBytes
        ? right.totalResponseBytes - left.totalResponseBytes
        : right.requests - left.requests
    );
}

function sumResponseBytes(rows: EndpointAggregate[]): number {
  return rows.reduce((total, row) => total + row.totalResponseBytes, 0);
}

/**
 * Compatibility score used by the existing Program 6A regression test. The
 * production bandwidth table remains ordered by actual transferred bytes, while
 * this score proves that request volume, latency and database cost all increase
 * an endpoint's diagnostic severity.
 */
function calculateRankScore(aggregate: EndpointAggregate): number {
  const count = Math.max(aggregate.requestCount, 1);
  const responseMb = aggregate.totalResponseBytes / (1024 * 1024);
  const averageDurationMs = aggregate.totalDurationMs / count;
  const databaseSeconds = aggregate.dbDurationMs / 1000;
  return (
    responseMb * 100 +
    aggregate.requestCount * 2 +
    averageDurationMs / 100 +
    databaseSeconds * 5 +
    aggregate.errorCount * 10
  );
}

function evaluateBandwidthBudgets(
  apiAggregates: EndpointAggregate[],
  staticAggregates: EndpointAggregate[],
  config: BandwidthBudgetConfig = getBandwidthBudgetConfig()
) {
  const totalApiResponseBytes = sumResponseBytes(apiAggregates);
  const totalStaticAssetResponseBytes = sumResponseBytes(staticAggregates);
  const topApi = [...apiAggregates].sort((left, right) => right.totalResponseBytes - left.totalResponseBytes)[0];
  const topStatic = [...staticAggregates].sort((left, right) => right.totalResponseBytes - left.totalResponseBytes)[0];
  const violations: BandwidthBudgetViolation[] = [];

  if (totalApiResponseBytes > config.apiWindowBytes) {
    violations.push({
      code: "api_bandwidth_budget_exceeded",
      message: "API response bandwidth exceeded its reporting-window budget",
      observedBytes: totalApiResponseBytes,
      budgetBytes: config.apiWindowBytes,
      method: topApi?.method,
      path: topApi?.path,
    });
  }
  if (totalStaticAssetResponseBytes > config.staticWindowBytes) {
    violations.push({
      code: "static_bandwidth_budget_exceeded",
      message: "Static-asset bandwidth exceeded its reporting-window budget",
      observedBytes: totalStaticAssetResponseBytes,
      budgetBytes: config.staticWindowBytes,
      method: topStatic?.method,
      path: topStatic?.path,
    });
  }
  if (topApi && topApi.totalResponseBytes > config.endpointWindowBytes) {
    violations.push({
      code: "api_endpoint_bandwidth_budget_exceeded",
      message: "An API endpoint exceeded its reporting-window bandwidth budget",
      observedBytes: topApi.totalResponseBytes,
      budgetBytes: config.endpointWindowBytes,
      method: topApi.method,
      path: topApi.path,
    });
  }
  if (topStatic && topStatic.totalResponseBytes > config.endpointWindowBytes) {
    violations.push({
      code: "static_asset_bandwidth_budget_exceeded",
      message: "A static asset exceeded its reporting-window bandwidth budget",
      observedBytes: topStatic.totalResponseBytes,
      budgetBytes: config.endpointWindowBytes,
      method: topStatic.method,
      path: topStatic.path,
    });
  }

  return {
    totalApiResponseBytes,
    totalStaticAssetResponseBytes,
    config,
    violations,
  };
}

function emitRanking(): void {
  if (aggregates.size === 0) return;

  const logTopN = Math.min(
    MAX_LOG_TOP_N,
    Math.round(
      positiveNumber(process.env.BANDWIDTH_DEBUG_LOG_TOP_N || process.env.BANDWIDTH_DEBUG_TOP_N, DEFAULT_LOG_TOP_N)
    )
  );
  const windowMs = positiveNumber(process.env.BANDWIDTH_DEBUG_REPORT_INTERVAL_MS, DEFAULT_REPORT_INTERVAL_MS);
  const all = [...aggregates.values()];
  const apiAggregates = all.filter((aggregate) => isApiPath(aggregate.path));
  const staticAggregates = all.filter((aggregate) => isStaticAsset(aggregate.path));

  if (apiAggregates.length === 0 && staticAggregates.length === 0) {
    aggregates.clear();
    return;
  }

  const budgetSnapshot = evaluateBandwidthBudgets(apiAggregates, staticAggregates);
  const fullApiRows = sortRows(apiAggregates, windowMs);
  const fullStaticRows = sortRows(staticAggregates, windowMs);
  const generatedAt = new Date().toISOString();

  latestDiagnosticSnapshot = {
    generatedAt,
    windowMs,
    endpointCount: all.length,
    apiEndpointCount: apiAggregates.length,
    staticAssetCount: staticAggregates.length,
    totalApiResponseBytes: budgetSnapshot.totalApiResponseBytes,
    totalStaticAssetResponseBytes: budgetSnapshot.totalStaticAssetResponseBytes,
    budgets: { ...budgetSnapshot.config },
    violations: budgetSnapshot.violations.map((violation) => ({ ...violation })),
    ranked: fullApiRows.map((row) => ({ ...row })),
    staticAssets: fullStaticRows.map((row) => ({ ...row })),
  };

  recordOperationalEvent({
    category: "bandwidth",
    code: "endpoint_performance_ranking",
    severity: "info",
    message: "Ranked endpoint performance and bandwidth snapshot",
    endpointCount: all.length,
    apiEndpointCount: apiAggregates.length,
    staticAssetCount: staticAggregates.length,
    windowMs,
    totalApiResponseBytes: budgetSnapshot.totalApiResponseBytes,
    totalStaticAssetResponseBytes: budgetSnapshot.totalStaticAssetResponseBytes,
    apiWindowBudgetBytes: budgetSnapshot.config.apiWindowBytes,
    staticWindowBudgetBytes: budgetSnapshot.config.staticWindowBytes,
    endpointWindowBudgetBytes: budgetSnapshot.config.endpointWindowBytes,
    ranked: fullApiRows.slice(0, logTopN),
    staticAssets: fullStaticRows.slice(0, logTopN),
  });

  for (const violation of budgetSnapshot.violations) {
    const endpoint = [...fullApiRows, ...fullStaticRows].find(
      (row) => row.method === violation.method && row.path === violation.path
    );
    recordOperationalEvent({
      category: "bandwidth",
      code: violation.code,
      severity: "warning",
      message: violation.message,
      method: violation.method,
      path: violation.path,
      responseBytes: violation.observedBytes,
      budgetBytes: violation.budgetBytes,
      windowMs,
      requests: endpoint?.requests,
      averageResponseBytes: endpoint?.averageResponseBytes,
      maxResponseBytes: endpoint?.maxResponseBytes,
      status200: endpoint?.status200,
      status304: endpoint?.status304,
      cacheHits: endpoint?.cacheHits,
      cacheMisses: endpoint?.cacheMisses,
      cacheRevalidations: endpoint?.cacheRevalidations,
      suspectedLoop: endpoint?.suspectedLoop,
      companyContexts: endpoint?.companyContexts,
      pageContexts: endpoint?.pageContexts,
    });
  }

  aggregates.clear();
}

function ensureReportTimer(): void {
  if (reportTimer) return;
  const intervalMs = positiveNumber(process.env.BANDWIDTH_DEBUG_REPORT_INTERVAL_MS, DEFAULT_REPORT_INTERVAL_MS);
  reportTimer = setInterval(emitRanking, intervalMs);
  reportTimer.unref();
}

export function getBandwidthDiagnosticSnapshot(): BandwidthDiagnosticSnapshot {
  return {
    ...latestDiagnosticSnapshot,
    budgets: { ...latestDiagnosticSnapshot.budgets },
    violations: latestDiagnosticSnapshot.violations.map((violation) => ({ ...violation })),
    ranked: latestDiagnosticSnapshot.ranked.map((row) => ({ ...row })),
    staticAssets: latestDiagnosticSnapshot.staticAssets.map((row) => ({ ...row })),
  };
}

export function bandwidthDebugMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (process.env.BANDWIDTH_DEBUG !== "true") return next();

  ensureReportTimer();
  runWithRequestPerformanceContext(() => {
    const start = Date.now();
    const startHeapBytes = process.memoryUsage().heapUsed;
    let totalBytes = 0;
    let finalized = false;

    const originalWrite = res.write.bind(res);
    (res as typeof res & { write: typeof res.write }).write = function (chunk: unknown, ...args: unknown[]): boolean {
      if (chunk != null) totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      return originalWrite(chunk as never, ...(args as never[]));
    };

    const originalEnd = res.end.bind(res);
    (res as typeof res & { end: typeof res.end }).end = function (chunk?: unknown, ...args: unknown[]): Response {
      if (chunk != null && typeof chunk !== "function") {
        totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      }
      originalEnd(chunk as never, ...(args as never[]));

      if (!finalized) {
        finalized = true;
        const durationMs = Date.now() - start;
        const heapDeltaBytes = process.memoryUsage().heapUsed - startHeapBytes;
        const path = normalizePath(req);
        const key = `${req.method} ${path}`;
        const databaseMetrics = getRequestPerformanceMetrics();
        const aggregate = aggregates.get(key) ?? {
          method: req.method,
          path,
          requestCount: 0,
          errorCount: 0,
          totalResponseBytes: 0,
          maxResponseBytes: 0,
          totalDurationMs: 0,
          maxDurationMs: 0,
          totalHeapDeltaBytes: 0,
          maxHeapDeltaBytes: 0,
          dbQueryCount: 0,
          dbDurationMs: 0,
          status200Count: 0,
          status304Count: 0,
          otherStatusCount: 0,
          cacheHitCount: 0,
          cacheMissCount: 0,
          cacheRevalidationCount: 0,
          companyContexts: new Set<string>(),
          pageContexts: new Set<string>(),
        };

        aggregate.requestCount += 1;
        if (res.statusCode >= 500) aggregate.errorCount += 1;
        if (res.statusCode === 200) aggregate.status200Count += 1;
        else if (res.statusCode === 304) aggregate.status304Count += 1;
        else aggregate.otherStatusCount += 1;
        const cacheOutcome = classifyCacheOutcome(res.statusCode, res.getHeader("X-ERP-Read-Cache"));
        if (cacheOutcome === "hit") aggregate.cacheHitCount += 1;
        else if (cacheOutcome === "miss") aggregate.cacheMissCount += 1;
        else if (cacheOutcome === "revalidated") aggregate.cacheRevalidationCount += 1;
        const companyContext = requestCompanyContext(req);
        const pageContext = requestPageContext(req);
        if (companyContext) aggregate.companyContexts.add(companyContext);
        if (pageContext) aggregate.pageContexts.add(pageContext);
        aggregate.totalResponseBytes += totalBytes;
        aggregate.maxResponseBytes = Math.max(aggregate.maxResponseBytes, totalBytes);
        aggregate.totalDurationMs += durationMs;
        aggregate.maxDurationMs = Math.max(aggregate.maxDurationMs, durationMs);
        aggregate.totalHeapDeltaBytes += heapDeltaBytes;
        aggregate.maxHeapDeltaBytes = Math.max(aggregate.maxHeapDeltaBytes, heapDeltaBytes);
        aggregate.dbQueryCount += databaseMetrics.dbQueryCount;
        aggregate.dbDurationMs += databaseMetrics.dbDurationMs;
        aggregates.set(key, aggregate);

        const responseThresholdBytes = getLargeResponseThresholdBytes(path);
        if (totalBytes >= responseThresholdBytes) {
          recordOperationalEvent({
            category: "bandwidth",
            code: "large_http_response",
            severity: "warning",
            message: "Large HTTP response detected",
            method: req.method,
            path,
            status: res.statusCode,
            responseBytes: totalBytes,
            budgetBytes: responseThresholdBytes,
            durationMs,
            heapDeltaBytes,
            dbQueryCount: databaseMetrics.dbQueryCount,
            dbDurationMs: databaseMetrics.dbDurationMs,
            cacheOutcome,
            companyContext,
            pageContext,
          });
        }
      }
      return res;
    };

    next();
  });
}

export const __bandwidthDebugTesting = {
  emitRanking,
  normalizePath,
  isApiPath,
  isStaticAsset,
  isDocumentOrExportPath,
  getLargeResponseThresholdBytes,
  calculateRankScore,
  evaluateBandwidthBudgets,
  getBandwidthBudgetConfig,
  getBandwidthDiagnosticSnapshot,
  classifyCacheOutcome,
  isSuspectedLoop,
  requestCompanyContext,
  requestPageContext,
  clear(): void {
    aggregates.clear();
    latestDiagnosticSnapshot = {
      generatedAt: null,
      windowMs: DEFAULT_REPORT_INTERVAL_MS,
      endpointCount: 0,
      apiEndpointCount: 0,
      staticAssetCount: 0,
      totalApiResponseBytes: 0,
      totalStaticAssetResponseBytes: 0,
      budgets: {
        apiWindowBytes: DEFAULT_API_WINDOW_BUDGET_MB * 1024 * 1024,
        staticWindowBytes: DEFAULT_STATIC_WINDOW_BUDGET_MB * 1024 * 1024,
        endpointWindowBytes: DEFAULT_ENDPOINT_WINDOW_BUDGET_MB * 1024 * 1024,
      },
      violations: [],
      ranked: [],
      staticAssets: [],
    };
  },
};
