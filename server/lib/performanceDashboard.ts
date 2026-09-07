import type { Request, Response } from "express";
import { pool } from "../db";
import { evaluateOperationalAlerts, getOperationalIncidentSnapshot } from "./operationalAlerts";
import { getRuntimePerformanceSnapshot } from "./runtimePerformance";

const CLIENT_ABORT_STATUS = 499;

interface RequestSample {
  timestamp: number;
  method: string;
  routeTemplate: string;
  mode: string;
  status: number;
  durationMs: number;
  responseBytes: number;
  dbQueryCount: number;
  dbDurationMs: number;
}
interface RouteAggregate {
  method: string;
  route: string;
  mode: string;
  count: number;
  errors: number;
  clientAborts: number;
  totalMs: number;
  maxMs: number;
  bytes: number;
  dbMs: number;
  durations: number[];
}
function finiteConfig(name: string, fallback: number, minimum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(minimum, parsed) : fallback;
}
const WINDOW_MS = finiteConfig("PERFORMANCE_DASHBOARD_WINDOW_MS", 15 * 60_000, 60_000);
const MAX_SAMPLES = finiteConfig("PERFORMANCE_DASHBOARD_MAX_SAMPLES", 5_000, 500);
const samples: RequestSample[] = [];
function prune(now = Date.now()): void {
  const cutoff = now - WINDOW_MS;
  while (samples.length && samples[0].timestamp < cutoff) samples.shift();
  if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
}
function percentile(values: number[], ratio: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))]);
}
function modeForPath(path: string): string {
  if (path.startsWith("/api/factory/pos/") || path.startsWith("/api/pos/")) return "POS";
  if (path.startsWith("/api/factory/")) return "Factory";
  if (path.startsWith("/api/sp/")) return "Supplier Partner";
  if (path.startsWith("/api/properties/")) return "Properties";
  return "ERP";
}
export function resetPerformanceDashboardForTests(): void {
  samples.length = 0;
}
export function recordPerformanceSample(input: Omit<RequestSample, "timestamp" | "mode">): void {
  samples.push({ ...input, timestamp: Date.now(), mode: modeForPath(input.routeTemplate) });
  prune();
}
export function getPerformanceDashboardSnapshot() {
  prune();
  const memory = process.memoryUsage(),
    completed = samples.length,
    durations = samples.map((s) => s.durationMs),
    errors = samples.filter((s) => s.status >= 500).length,
    clientAborts = samples.filter((s) => s.status === CLIENT_ABORT_STATUS).length;
  const slow = samples.filter((s) => s.durationMs >= finiteConfig("SLOW_REQUEST_MS", 500, 0)).length;
  const routeMap = new Map<string, RouteAggregate>();
  for (const sample of samples) {
    const key = `${sample.method} ${sample.routeTemplate}`;
    const row = routeMap.get(key) || {
      method: sample.method,
      route: sample.routeTemplate,
      mode: sample.mode,
      count: 0,
      errors: 0,
      clientAborts: 0,
      totalMs: 0,
      maxMs: 0,
      bytes: 0,
      dbMs: 0,
      durations: [],
    };
    row.count++;
    row.errors += sample.status >= 500 ? 1 : 0;
    row.clientAborts += sample.status === CLIENT_ABORT_STATUS ? 1 : 0;
    row.totalMs += sample.durationMs;
    row.maxMs = Math.max(row.maxMs, sample.durationMs);
    row.bytes += sample.responseBytes;
    row.dbMs += sample.dbDurationMs;
    row.durations.push(sample.durationMs);
    routeMap.set(key, row);
  }
  const routes = [...routeMap.values()].map(({ durations: values, ...row }) => ({
    ...row,
    p95Ms: percentile(values, 0.95),
    averageMs: Math.round(row.totalMs / Math.max(1, row.count)),
    averageBytes: Math.round(row.bytes / Math.max(1, row.count)),
    averageDbMs: Math.round(row.dbMs / Math.max(1, row.count)),
  }));
  const byMode = ["ERP", "Factory", "Supplier Partner", "Properties", "POS"].map((mode) => {
    const rows = samples.filter((s) => s.mode === mode);
    return {
      mode,
      requests: rows.length,
      errors: rows.filter((s) => s.status >= 500).length,
      clientAborts: rows.filter((s) => s.status === CLIENT_ABORT_STATUS).length,
      p95Ms: percentile(
        rows.map((s) => s.durationMs),
        0.95
      ),
    };
  });
  const poolMax = Number(pool.options?.max || 0),
    poolTotal = Number(pool.totalCount || 0),
    poolIdle = Number(pool.idleCount || 0),
    runtime = getRuntimePerformanceSnapshot();
  return {
    timestamp: new Date().toISOString(),
    windowMinutes: Math.round(WINDOW_MS / 60000),
    sampleLimit: MAX_SAMPLES,
    summary: {
      requests: completed,
      errors,
      errorPercent: completed ? Math.round((errors / completed) * 10000) / 100 : 0,
      clientAborts,
      clientAbortPercent: completed ? Math.round((clientAborts / completed) * 10000) / 100 : 0,
      slow,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      p99Ms: percentile(durations, 0.99),
      responseBytes: samples.reduce((n, s) => n + s.responseBytes, 0),
      dbDurationMs: Math.round(samples.reduce((n, s) => n + s.dbDurationMs, 0)),
    },
    memoryMb: {
      rss: Math.round(memory.rss / 1048576),
      heapUsed: Math.round(memory.heapUsed / 1048576),
      heapTotal: Math.round(memory.heapTotal / 1048576),
    },
    databasePool: {
      max: poolMax,
      total: poolTotal,
      idle: poolIdle,
      active: Math.max(0, poolTotal - poolIdle),
      waiting: Number(pool.waitingCount || 0),
    },
    byMode,
    slowestRoutes: [...routes].sort((a, b) => b.p95Ms - a.p95Ms).slice(0, 20),
    abortedRoutes: [...routes]
      .filter((route) => route.clientAborts > 0)
      .sort((a, b) => b.clientAborts - a.clientAborts || b.maxMs - a.maxMs)
      .slice(0, 20),
    largestRoutes: [...routes].sort((a, b) => b.averageBytes - a.averageBytes).slice(0, 20),
    busiestRoutes: [...routes].sort((a, b) => b.count - a.count).slice(0, 20),
    runtime,
    backgroundJobs: runtime.backgroundJobs,
    externalDependencies: runtime.dependencies,
  };
}
function isMonitoringRole(req: Request): boolean {
  const role = String(req.session?.currentRole || req.user?.role || "").toLowerCase();
  return role === "admin" || role === "developer";
}
function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] || c
  );
}
export function handlePerformanceDashboard(req: Request, res: Response): boolean {
  const paths = [
    "/api/health/performance",
    "/api/health/performance.json",
    "/api/health/incidents",
    "/api/health/incidents.json",
  ];
  if (req.method !== "GET" || !paths.includes(req.path)) return false;
  if (!isMonitoringRole(req)) {
    res.status(403).json({ message: "Admin or Developer access required." });
    return true;
  }
  const performance = getPerformanceDashboardSnapshot();
  if (req.path.startsWith("/api/health/incidents")) {
    if (process.env.OBSERVABILITY_ALERTS_ENABLED === "true") evaluateOperationalAlerts(performance);
    const snapshot = getOperationalIncidentSnapshot();
    if (req.path.endsWith(".json")) res.status(200).json(snapshot);
    else
      res
        .status(200)
        .type("html")
        .send(
          `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>ERP Incidents</title></head><body><h1>Operational Incidents</h1><p><a href="/api/health/performance">Performance</a> · <a href="/api/health/incidents.json">JSON</a></p><pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre></body></html>`
        );
    return true;
  }
  if (req.path.endsWith(".json")) {
    res.status(200).json(performance);
    return true;
  }
  res
    .status(200)
    .type("html")
    .send(
      `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="refresh" content="30"><title>ERP Performance</title></head><body><h1>Production Performance</h1><p>Bounded ${performance.windowMinutes}-minute window · maximum ${performance.sampleLimit} samples · <a href="/api/health/performance.json">JSON</a> · <a href="/api/health/incidents">Incidents</a></p><pre>${escapeHtml(JSON.stringify(performance, null, 2))}</pre></body></html>`
    );
  return true;
}
