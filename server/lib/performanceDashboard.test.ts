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
    });
  });
});
