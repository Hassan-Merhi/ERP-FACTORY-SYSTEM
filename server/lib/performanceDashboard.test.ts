import { beforeEach, describe, expect, it, vi } from "vitest";

const poolState = vi.hoisted(() => ({
  options: { max: 10 },
  totalCount: 4,
  idleCount: 2,
  waitingCount: 0,
}));

vi.mock("../db", () => ({
  pool: poolState,
}));

vi.mock("./operationalAlerts", () => ({
  evaluateOperationalAlerts: vi.fn(),
  getOperationalIncidentSnapshot: vi.fn(() => ({ incidents: [] })),
}));

vi.mock("./runtimePerformance", () => ({
  getRuntimePerformanceSnapshot: vi.fn(() => ({
    backgroundJobs: [],
    dependencies: [],
  })),
}));

import {
  getPerformanceDashboardSnapshot,
  recordPerformanceSample,
  resetPerformanceDashboardForTests,
} from "./performanceDashboard";

describe("performanceDashboard client abort visibility", () => {
  beforeEach(() => {
    resetPerformanceDashboardForTests();
  });

  it("surfaces synthetic 499 client aborts without counting them as server errors", () => {
    recordPerformanceSample({
      method: "POST",
      routeTemplate: "/api/pos/sales",
      status: 499,
      durationMs: 2500,
      responseBytes: 128,
      dbQueryCount: 3,
      dbDurationMs: 320,
    });
    recordPerformanceSample({
      method: "POST",
      routeTemplate: "/api/pos/sales",
      status: 200,
      durationMs: 90,
      responseBytes: 512,
      dbQueryCount: 2,
      dbDurationMs: 40,
    });

    const snapshot = getPerformanceDashboardSnapshot();

    expect(snapshot.summary).toMatchObject({
      requests: 2,
      errors: 0,
      errorPercent: 0,
      clientAborts: 1,
      clientAbortPercent: 50,
      dbQueryCount: 5,
      averageDbQueriesPerRequest: 2.5,
      dbDurationMs: 360,
    });
    expect(snapshot.abortedRoutes[0]).toMatchObject({
      method: "POST",
      route: "/api/pos/sales",
      mode: "POS",
      count: 2,
      errors: 0,
      clientAborts: 1,
      maxMs: 2500,
    });
    expect(snapshot.byMode.find((row) => row.mode === "POS")).toMatchObject({
      requests: 2,
      errors: 0,
      clientAborts: 1,
      averageDbQueries: 2.5,
    });
  });

  it("ranks database-heavy/chatty routes and exposes actionable latency budgets", () => {
    recordPerformanceSample({
      method: "GET",
      routeTemplate: "/api/inventory",
      status: 200,
      durationMs: 620,
      responseBytes: 80_000,
      dbQueryCount: 24,
      dbDurationMs: 410,
    });
    recordPerformanceSample({
      method: "GET",
      routeTemplate: "/api/inventory",
      status: 200,
      durationMs: 710,
      responseBytes: 90_000,
      dbQueryCount: 28,
      dbDurationMs: 470,
    });
    recordPerformanceSample({
      method: "GET",
      routeTemplate: "/api/health",
      status: 200,
      durationMs: 20,
      responseBytes: 200,
      dbQueryCount: 0,
      dbDurationMs: 0,
    });

    const snapshot = getPerformanceDashboardSnapshot();

    expect(snapshot.budgets.normal).toEqual({ latencyMs: 500, dbMs: 300, dbQueries: 20 });
    expect(snapshot.databaseHeavyRoutes[0]).toMatchObject({
      method: "GET",
      route: "/api/inventory",
      workloadClass: "normal",
      averageDbMs: 440,
      averageDbQueries: 26,
    });
    expect(snapshot.chattyDatabaseRoutes[0]).toMatchObject({
      route: "/api/inventory",
      averageDbQueries: 26,
    });
    expect(snapshot.budgetBreaches[0]).toMatchObject({
      route: "/api/inventory",
      budgetBreaches: ["latency", "db_time", "db_queries"],
    });
    expect(snapshot.summary.dbSharePercent).toBeGreaterThan(0);
  });

  it("gives report-sized routes the heavier latency/DB budget instead of flagging them as normal APIs", () => {
    recordPerformanceSample({
      method: "GET",
      routeTemplate: "/api/sales-report",
      status: 200,
      durationMs: 900,
      responseBytes: 900_000,
      dbQueryCount: 30,
      dbDurationMs: 600,
    });

    const snapshot = getPerformanceDashboardSnapshot();
    expect(snapshot.slowestRoutes[0]).toMatchObject({
      route: "/api/sales-report",
      workloadClass: "heavy",
      latencyBudgetMs: 1000,
      dbBudgetMs: 700,
      dbQueryBudget: 40,
      budgetBreaches: [],
    });
  });
});
