/**
 * performanceDashboard: sample window / cap configuration, mode routing,
 * empty and zero-duration aggregates, tie-breaking route rankings, pool
 * fallbacks and the monitoring endpoint's method / path / role gates and
 * HTML / JSON renderings. The DB pool, incident store and runtime snapshot
 * are stubbed at their module boundaries.
 */
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  pool: {} as Record<string, unknown>,
  evaluate: vi.fn(),
  incidents: vi.fn(() => ({ incidents: [{ title: '<b>&"x"' }] })),
}));
vi.mock("../server/db", () => ({ pool: h.pool }));
vi.mock("../server/lib/operationalAlerts", () => ({
  evaluateOperationalAlerts: h.evaluate,
  getOperationalIncidentSnapshot: h.incidents,
}));
vi.mock("../server/lib/runtimePerformance", () => ({
  getRuntimePerformanceSnapshot: () => ({ backgroundJobs: ["job"], dependencies: ["dep"] }),
}));

import {
  getPerformanceDashboardSnapshot,
  handlePerformanceDashboard,
  recordPerformanceSample,
  resetPerformanceDashboardForTests,
} from "../server/lib/performanceDashboard";

type Sample = Parameters<typeof recordPerformanceSample>[0];
const sample = (over: Partial<Sample>): Sample => ({
  method: "GET",
  routeTemplate: "/api/x",
  status: 200,
  durationMs: 10,
  responseBytes: 100,
  dbQueryCount: 1,
  dbDurationMs: 5,
  ...over,
});

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    contentType: "",
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(body: unknown) {
      res.body = body;
      return res;
    },
    type(t: string) {
      res.contentType = t;
      return res;
    },
    send(body: unknown) {
      res.body = body;
      return res;
    },
  };
  return res;
}
const call = (method: string, path: string, who: { session?: string; user?: string } = {}) => {
  const res = fakeRes();
  const req = {
    method,
    path,
    session: who.session ? { currentRole: who.session } : undefined,
    user: who.user ? { role: who.user } : undefined,
  } as unknown as Request;
  const handled = handlePerformanceDashboard(req, res as unknown as Response);
  return { handled, res };
};

beforeEach(() => {
  resetPerformanceDashboardForTests();
  for (const key of Object.keys(h.pool)) delete h.pool[key];
  h.evaluate.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OBSERVABILITY_ALERTS_ENABLED;
});

describe("snapshot aggregation", () => {
  it("reports zeros for an empty window and falls back to zero pool counters", () => {
    const snap = getPerformanceDashboardSnapshot();
    expect(snap.summary).toMatchObject({
      requests: 0,
      errorPercent: 0,
      clientAbortPercent: 0,
      averageDbQueriesPerRequest: 0,
      dbSharePercent: 0,
    });
    expect(snap.databasePool).toEqual({ max: 0, total: 0, idle: 0, active: 0, waiting: 0 });
    expect(snap.byMode.every((m) => m.averageDbMs === 0 && m.dbSharePercent === 0)).toBe(true);
    expect(snap.backgroundJobs).toEqual(["job"]);
  });

  it("assigns every mode, counts 5xx errors and handles zero-duration routes", () => {
    Object.assign(h.pool, { options: { max: 8 }, totalCount: 5, idleCount: 1, waitingCount: 2 });
    recordPerformanceSample(sample({ routeTemplate: "/api/factory/pos/sale" }));
    recordPerformanceSample(sample({ routeTemplate: "/api/factory/bales" }));
    recordPerformanceSample(sample({ routeTemplate: "/api/sp/deals", status: 503 }));
    recordPerformanceSample(sample({ routeTemplate: "/api/properties/units" }));
    recordPerformanceSample(sample({ routeTemplate: "/api/zero", durationMs: 0, dbDurationMs: 0, dbQueryCount: 0 }));
    const snap = getPerformanceDashboardSnapshot();
    expect(Object.fromEntries(snap.byMode.map((m) => [m.mode, m.requests]))).toEqual({
      ERP: 1,
      Factory: 1,
      "Supplier Partner": 1,
      Properties: 1,
      POS: 1,
    });
    expect(snap.summary.errors).toBe(1);
    expect(snap.databasePool).toEqual({ max: 8, total: 5, idle: 1, active: 4, waiting: 2 });
    const zero = snap.busiestRoutes.find((r) => r.route === "/api/zero");
    expect(zero).toMatchObject({ dbSharePercent: 0, averageDbQueries: 0 });
    expect(snap.databaseHeavyRoutes.some((r) => r.route === "/api/zero")).toBe(false);
  });

  it("breaks ranking ties on the secondary key", () => {
    // Same average DB ms, different share; same query count, different DB ms;
    // same breach count, different p95; same aborts, different max.
    recordPerformanceSample(sample({ routeTemplate: "/api/a", durationMs: 2000, dbDurationMs: 400, dbQueryCount: 30 }));
    recordPerformanceSample(sample({ routeTemplate: "/api/b", durationMs: 800, dbDurationMs: 400, dbQueryCount: 30 }));
    recordPerformanceSample(sample({ routeTemplate: "/api/c", durationMs: 900, dbDurationMs: 350, dbQueryCount: 30 }));
    recordPerformanceSample(sample({ routeTemplate: "/api/d", status: 499, durationMs: 50 }));
    recordPerformanceSample(sample({ routeTemplate: "/api/e", status: 499, durationMs: 70 }));
    const snap = getPerformanceDashboardSnapshot();
    expect(snap.databaseHeavyRoutes.slice(0, 2).map((r) => r.route)).toEqual(["/api/b", "/api/a"]);
    expect(snap.chattyDatabaseRoutes.slice(0, 3).map((r) => r.route)).toEqual(["/api/a", "/api/b", "/api/c"]);
    expect(snap.budgetBreaches.slice(0, 3).map((r) => r.route)).toEqual(["/api/a", "/api/c", "/api/b"]);
    expect(snap.abortedRoutes.map((r) => r.route)).toEqual(["/api/e", "/api/d"]);
  });

  it("drops samples older than the window", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    recordPerformanceSample(sample({ routeTemplate: "/api/old" }));
    vi.setSystemTime(new Date("2026-01-01T02:00:00Z"));
    recordPerformanceSample(sample({ routeTemplate: "/api/new" }));
    expect(getPerformanceDashboardSnapshot().busiestRoutes.map((r) => r.route)).toEqual(["/api/new"]);
  });
});

describe("window configuration", () => {
  it("clamps configured window and sample limits and caps the buffer", async () => {
    vi.resetModules();
    process.env.PERFORMANCE_DASHBOARD_WINDOW_MS = "10";
    process.env.PERFORMANCE_DASHBOARD_MAX_SAMPLES = "1";
    try {
      const mod = await import("../server/lib/performanceDashboard");
      for (let i = 0; i < 502; i++) mod.recordPerformanceSample(sample({}));
      const snap = mod.getPerformanceDashboardSnapshot();
      expect([snap.windowMinutes, snap.sampleLimit, snap.summary.requests]).toEqual([1, 500, 500]);
    } finally {
      delete process.env.PERFORMANCE_DASHBOARD_WINDOW_MS;
      delete process.env.PERFORMANCE_DASHBOARD_MAX_SAMPLES;
    }
  });
});

describe("monitoring endpoint", () => {
  it("ignores other methods and paths", () => {
    expect(call("POST", "/api/health/performance").handled).toBe(false);
    expect(call("GET", "/api/health/other").handled).toBe(false);
  });

  it("refuses roles other than admin or developer", () => {
    const anon = call("GET", "/api/health/performance");
    expect([anon.handled, anon.res.statusCode, anon.res.body]).toEqual([
      true,
      403,
      { message: "Admin or Developer access required." },
    ]);
    expect(call("GET", "/api/health/performance.json", { session: "Accountant" }).res.statusCode).toBe(403);
  });

  it("serves performance JSON and escaped HTML to admin and developer roles", () => {
    recordPerformanceSample(sample({ routeTemplate: '/api/<q>&"' }));
    const json = call("GET", "/api/health/performance.json", { user: "Developer" });
    expect(json.res.statusCode).toBe(200);
    expect(json.res.body).toMatchObject({ summary: { requests: 1 } });
    const html = call("GET", "/api/health/performance", { session: "Admin" });
    expect(html.res.contentType).toBe("html");
    expect(String(html.res.body)).toContain("/api/&lt;q&gt;&amp;\\&quot;");
  });

  it("serves incidents as JSON or HTML and evaluates alerts only when enabled", () => {
    const json = call("GET", "/api/health/incidents.json", { session: "admin" });
    expect(json.res.body).toEqual({ incidents: [{ title: '<b>&"x"' }] });
    expect(h.evaluate).not.toHaveBeenCalled();
    process.env.OBSERVABILITY_ALERTS_ENABLED = "true";
    const html = call("GET", "/api/health/incidents", { session: "developer" });
    expect(h.evaluate).toHaveBeenCalledTimes(1);
    expect(String(html.res.body)).toContain("&lt;b&gt;&amp;\\&quot;x\\&quot;");
  });
});
