import type { Request, Response, NextFunction } from "express";
import {
  DEFAULT_API_WINDOW_BUDGET_MB,
  DEFAULT_STATIC_WINDOW_BUDGET_MB,
  DEFAULT_ENDPOINT_WINDOW_BUDGET_MB,
  getBandwidthBudgetConfig,
  positiveNumber,
  normalizePath,
  isApiPath,
  isStaticAsset,
  isDocumentOrExportPath,
  getLargeResponseThresholdBytes,
  classifyCacheOutcome,
  isSuspectedLoop,
  requestCompanyContext,
  requestPageContext,
} from "./bandwidthDebugHelpers";
import { recordOperationalEvent } from "../lib/operationalEvents";
import { getRequestPerformanceMetrics, runWithRequestPerformanceContext } from "../lib/requestPerformanceContext";
import {
  DEFAULT_LOG_TOP_N,
  MAX_LOG_TOP_N,
  aggregates,
  sortRows,
  calculateRankScore,
  evaluateBandwidthBudgets,
  type BandwidthDiagnosticSnapshot,
} from "./bandwidthDebugHelpers2";

const DEFAULT_REPORT_INTERVAL_MS = 5 * 60 * 1000;

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
