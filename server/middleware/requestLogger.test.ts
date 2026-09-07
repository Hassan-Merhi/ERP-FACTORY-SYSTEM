import { EventEmitter } from "node:events";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory below - which vitest lifts above this line -
// can close over it.
const poolState = vi.hoisted(() => ({
  options: { max: 10 },
  totalCount: 6,
  idleCount: 2,
  waitingCount: 0,
}));

vi.mock("../db", () => ({
  pool: poolState,
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { logger } from "../lib/logger";
import { resetPerformanceDashboardForTests } from "../lib/performanceDashboard";
import { getRequestMetricsSnapshot, requestLogger, resetRequestMetricsForTests } from "./requestLogger";

interface FakeResponse extends Response {
  emit(eventName: string | symbol, ...args: unknown[]): boolean;
  writableFinished: boolean;
}

function createRequest(path = "/api/reports/slow"): Request {
  return {
    method: "GET",
    path,
    originalUrl: path,
    baseUrl: "",
    headers: {},
    session: {},
    route: { path },
  } as unknown as Request;
}

function createResponse(): FakeResponse {
  const emitter = new EventEmitter();
  const response = Object.assign(emitter, {
    statusCode: 200,
    headersSent: false,
    writableFinished: false,
    setHeader: vi.fn(),
    write: vi.fn(() => true),
    end: vi.fn(),
  });
  response.end.mockImplementation(() => response);
  return response as unknown as FakeResponse;
}

describe("requestLogger health metrics", () => {
  beforeEach(() => {
    poolState.options.max = 10;
    poolState.totalCount = 6;
    poolState.idleCount = 2;
    poolState.waitingCount = 0;
    resetRequestMetricsForTests();
    resetPerformanceDashboardForTests();
    vi.clearAllMocks();
  });

  it("reports safe process, request baseline, and pool metrics without connection details", () => {
    const snapshot = getRequestMetricsSnapshot();

    expect(snapshot.status).toBe("ok");
    expect(snapshot.databasePool).toEqual({
      max: 10,
      total: 6,
      idle: 2,
      active: 4,
      waiting: 0,
      utilizationPercent: 40,
    });
    expect(snapshot.requests).toMatchObject({
      total: 0,
      active: 0,
      completed: 0,
      success: 0,
      expectedClientResponse: 0,
      clientError: 0,
      clientAbort: 0,
      serverError: 0,
      slow: 0,
      averageDurationMs: 0,
      maxDurationMs: 0,
      slowPercent: 0,
      clientAbortPercent: 0,
      serverErrorPercent: 0,
      slowRequestThresholdMs: 1000,
    });
    expect(snapshot.requests.durationBuckets).toEqual({
      under100: 0,
      under500: 0,
      under1000: 0,
      under5000: 0,
      over5000: 0,
    });
    expect(snapshot.process.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(snapshot.process.memoryMb.rss).toBeGreaterThan(0);
    expect(snapshot).not.toHaveProperty("connectionString");
    expect(JSON.stringify(snapshot)).not.toContain("DATABASE_URL");
  });

  it("marks the snapshot degraded when requests are waiting for a pool connection", () => {
    poolState.waitingCount = 3;

    const snapshot = getRequestMetricsSnapshot();

    expect(snapshot.status).toBe("degraded");
    expect(snapshot.databasePool.waiting).toBe(3);
  });

  it("records a disconnected API response exactly once as a client abort", () => {
    const req = createRequest();
    const res = createResponse();
    const next = vi.fn() as NextFunction;

    requestLogger(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getRequestMetricsSnapshot().requests).toMatchObject({ total: 1, active: 1, clientAbort: 0 });

    res.emit("close");

    expect(getRequestMetricsSnapshot().requests).toMatchObject({
      total: 1,
      active: 0,
      completed: 1,
      clientAbort: 1,
      clientAbortPercent: 100,
      success: 0,
      serverError: 0,
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "Client disconnected before response completed",
      expect.objectContaining({
        module: "http",
        action: "client_abort",
        routeTemplate: "/api/reports/slow",
        status: 499,
        responseStarted: false,
      })
    );

    res.writableFinished = true;
    res.emit("finish");
    expect(getRequestMetricsSnapshot().requests.clientAbort).toBe(1);
  });

  it("does not reclassify a normally finished response when the socket later closes", () => {
    const req = createRequest("/api/reports/ok");
    const res = createResponse();
    const next = vi.fn() as NextFunction;

    requestLogger(req, res, next);
    res.writableFinished = true;
    res.emit("finish");
    res.emit("close");

    expect(getRequestMetricsSnapshot().requests).toMatchObject({
      total: 1,
      active: 0,
      completed: 1,
      success: 1,
      clientAbort: 0,
    });
  });
});
