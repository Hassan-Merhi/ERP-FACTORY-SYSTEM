/**
 * requestLogger middleware on a small Express app: request ids, health and
 * metrics endpoints (with the monitoring-role refusal), the activity-history
 * company guard, response byte counting through every write/end overload, and
 * how each completion (success, client error, expected client response, server
 * error, slow, sampled, client abort, server destroy, closed event stream) is
 * counted and logged. The logger and operational-event sink are spied on.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const previous = process.env.REQUEST_LOG_SAMPLE_RATE;
  process.env.REQUEST_LOG_SAMPLE_RATE = "0.5";
  return {
    previous,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    recordOperationalEvent: vi.fn(),
    audit: vi.fn(),
  };
});

vi.mock("../server/lib/logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/lib/logger")>();
  return { ...actual, logger: { ...actual.logger, info: h.info, warn: h.warn, error: h.error } };
});
vi.mock("../server/lib/operationalEvents", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/lib/operationalEvents")>();
  return { ...actual, recordOperationalEvent: h.recordOperationalEvent };
});
vi.mock("../server/middleware/activityAudit", () => ({ writeSuccessfulActivityAudit: h.audit }));

import {
  getRequestMetricsSnapshot,
  requestLogger,
  resetRequestMetricsForTests,
} from "../server/middleware/requestLogger";
import { markExpectedClientResponse } from "../server/lib/expectedClientResponse";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.header("x-test-role");
    const company = req.header("x-test-company");
    (req as unknown as { session: Record<string, unknown> }).session = {
      currentRole: role,
      currentCompanyId: company ? Number(company) : undefined,
      factoryCompanyId: req.header("x-test-factory") ? 7 : undefined,
      currentLocationId: req.header("x-test-location") ? 3 : undefined,
      userId: req.header("x-test-user"),
    };
    next();
  });
  app.use(requestLogger);
  app.get("/api/ok", (_req, res) => res.json({ ok: true }));
  app.get("/api/bad", (_req, res) => res.status(400).json({ message: "bad" }));
  app.get("/api/boom", (_req, res) => res.status(503).json({ message: "down" }));
  app.get("/api/auth/me", (_req, res) => res.status(401).end());
  app.get("/api/expected", (_req, res) => {
    markExpectedClientResponse(res, "bale_scan_overload");
    res.status(409).json({ message: "confirm" });
  });
  app.get("/api/slow", async (_req, res) => {
    await wait(15);
    res.json({ slow: true });
  });
  app.get("/api/chunks", (req, res) => {
    const form = req.query.form;
    res.status(200);
    res.write("ab", () => undefined);
    res.write(Buffer.from("cde"));
    res.write("f", "utf8", () => undefined);
    if (form === "cb") res.end(() => undefined);
    else if (form === "chunk-cb") res.end("gh", () => undefined);
    else if (form === "none") res.end();
    else if (form === "enc") res.end("gh", "utf8", () => undefined);
    else res.end("gh");
  });
  app.get("/api/hang", () => undefined);
  app.get("/api/destroy", (_req, res) => {
    res.destroy(new Error("server gave up"));
  });
  app.get("/api/plain-destroy", (_req, res) => {
    res.destroy();
  });
  app.get("/api/stream", (_req, res) => {
    res.setHeader("content-type", "text/event-stream");
    res.write("data: hi\n\n");
  });
  app.get("/static/page", (_req, res) => res.send("page"));
  return app;
}

/** Sends a request and abandons it once the server has received it. */
async function abandon(server: http.Server, path: string, headers: Record<string, string> = {}) {
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    const req = http.get({ port, path, headers });
    req.on("error", () => resolve());
    setTimeout(() => {
      req.destroy();
      resolve();
    }, 40);
  });
  await wait(40);
}

describe("requestLogger", () => {
  const app = buildApp();
  let server: http.Server;

  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (h.previous === undefined) delete process.env.REQUEST_LOG_SAMPLE_RATE;
    else process.env.REQUEST_LOG_SAMPLE_RATE = h.previous;
  });
  beforeEach(() => {
    resetRequestMetricsForTests();
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SLOW_REQUEST_DEFAULT_MS;
  });

  it("echoes a well-formed request id and replaces a malformed one", async () => {
    const kept = await request(app).get("/api/ok").set("x-request-id", "abcd-1234-efgh");
    expect(kept.headers["x-request-id"]).toBe("abcd-1234-efgh");
    const replaced = await request(app).get("/api/ok").set("x-request-id", "bad id!");
    expect(replaced.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("answers health directly and guards metrics and dashboards by monitoring role", async () => {
    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.status).toBe("ok");
    const refused = await request(app).get("/api/health/metrics").set("x-test-role", "Manager");
    expect(refused.status).toBe(403);
    expect(refused.body.message).toBe("Admin or Developer access required.");
    const metrics = await request(app).get("/api/health/metrics").set("x-test-role", "Developer");
    expect(metrics.status).toBe(200);
    expect(metrics.body.requests.total).toBe(0);
    expect(metrics.body.databasePool).toHaveProperty("max");
    expect((await request(app).get("/api/health/performance").set("x-test-role", "Viewer")).status).toBe(403);
    expect((await request(app).get("/api/health/performance.json").set("x-test-role", "admin")).status).toBe(200);
    const observability = await request(app)
      .post("/api/auth/observability/client-error")
      .set("Origin", "https://evil.example");
    expect(observability.status).toBe(403);
  });

  it("refuses activity history without a selected company and passes it on with one", async () => {
    const refused = await request(app).get("/api/audit-log");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("AUDIT_COMPANY_REQUIRED");
    expect((await request(app).get("/api/audit-log").set("x-test-company", "-4")).status).toBe(409);
    const passed = await request(app).get("/api/audit-log").set("x-test-company", "5");
    expect(passed.status).toBe(404);
    expect(getRequestMetricsSnapshot().requests.clientError).toBe(1);
  });

  it("counts success, client errors, expected client responses and server errors", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    await request(app).get("/api/ok").set("x-test-user", "9").set("x-test-company", "2");
    expect(h.info).not.toHaveBeenCalled();
    expect(h.audit).toHaveBeenCalledWith(expect.anything(), 200);

    await request(app).get("/api/bad").set("x-test-factory", "1").set("x-test-location", "1");
    expect(h.warn).toHaveBeenCalledWith("GET /api/bad 400", expect.objectContaining({ factoryCompanyId: 7 }));

    await request(app).get("/api/auth/me");
    expect(h.warn).toHaveBeenCalledTimes(1);

    await request(app).get("/api/expected");
    expect(h.info).toHaveBeenCalledWith(
      "Request requires an expected client confirmation",
      expect.objectContaining({ action: "expected_client_response.bale_scan_overload", status: 409 })
    );

    await request(app).get("/api/boom").set("x-test-user", "9").set("x-test-company", "2");
    expect(h.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "http_server_error", status: 503, userId: 9, companyId: 2 })
    );
    await request(app).get("/api/boom");
    expect(h.recordOperationalEvent).toHaveBeenLastCalledWith(expect.not.objectContaining({ userId: 9 }));

    const snapshot = getRequestMetricsSnapshot().requests;
    expect(snapshot).toMatchObject({
      total: 6,
      active: 0,
      success: 1,
      clientError: 2,
      expectedClientResponse: 1,
      serverError: 2,
    });
    expect(snapshot.serverErrorPercent).toBeCloseTo(33.33, 1);
    expect(snapshot.averageDurationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs a sampled success and a slow request", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    await request(app).get("/api/ok");
    expect(h.info).toHaveBeenCalledWith("GET /api/ok 200", expect.objectContaining({ action: "request" }));

    process.env.SLOW_REQUEST_DEFAULT_MS = "5";
    await request(app).get("/api/slow").set("x-test-user", "4");
    expect(h.warn).toHaveBeenCalledWith(
      "GET /api/slow 200",
      expect.objectContaining({ action: "slow_request", slow: true, userId: "4" })
    );
    expect(getRequestMetricsSnapshot().requests.slow).toBe(1);
  });

  it("counts response bytes through every write and end overload", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.1);
    for (const form of ["cb", "none", "chunk-cb", "enc", "plain"]) {
      const res = await request(app).get(`/api/chunks?form=${form}`);
      expect(res.status).toBe(200);
      expect(res.text).toBe(form === "cb" || form === "none" ? "abcdef" : "abcdefgh");
    }
    const bytes = h.info.mock.calls.map((call) => (call[1] as { responseBytes: number }).responseBytes);
    expect(bytes).toEqual([6, 6, 8, 8, 8]);
  });

  it("does not count or log paths outside the API", async () => {
    await request(app).get("/static/page");
    expect(getRequestMetricsSnapshot().requests.total).toBe(0);
    expect(h.audit).not.toHaveBeenCalled();
  });

  it("records a client abort, a server destroy and a closed event stream", async () => {
    await abandon(server, "/api/hang", { "x-test-user": "3", "x-test-company": "8", "x-test-factory": "1" });
    expect(h.warn).toHaveBeenCalledWith(
      "Client disconnected before response completed",
      expect.objectContaining({ action: "client_abort", status: 499, userId: "3", companyId: 8 })
    );
    await abandon(server, "/api/hang", { "x-test-location": "1" });
    expect(h.warn).toHaveBeenLastCalledWith(
      "Client disconnected before response completed",
      expect.not.objectContaining({ userId: expect.anything() })
    );

    await abandon(server, "/api/destroy");
    expect(h.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "http_server_error", status: 500 })
    );
    await abandon(server, "/api/plain-destroy");

    await abandon(server, "/api/stream");
    await abandon(server, "/api/hang", { accept: "text/event-stream" });

    const snapshot = getRequestMetricsSnapshot().requests;
    expect(snapshot.clientAbort).toBe(3);
    expect(snapshot.serverError).toBe(1);
    expect(snapshot.streamClosed).toBe(2);
    expect(snapshot.active).toBe(0);
    expect(snapshot.clientAbortPercent).toBe(75);
    expect(h.audit).not.toHaveBeenCalled();
  });
});
