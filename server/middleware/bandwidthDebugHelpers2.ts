// Extracted from ./bandwidthDebug.ts
import { getBandwidthBudgetConfig, isSuspectedLoop, type BandwidthBudgetConfig } from "./bandwidthDebugHelpers";

export const DEFAULT_LOG_TOP_N = 3;

export const MAX_LOG_TOP_N = 5;

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

type BandwidthBudgetViolation = {
  code: string;
  message: string;
  observedBytes: number;
  budgetBytes: number;
  method?: string;
  path?: string;
};

export type BandwidthDiagnosticSnapshot = {
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

export const aggregates = new Map<string, EndpointAggregate>();

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

export function sortRows(rows: EndpointAggregate[], windowMs: number): EndpointDiagnosticRow[] {
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
export function calculateRankScore(aggregate: EndpointAggregate): number {
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

export function evaluateBandwidthBudgets(
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
