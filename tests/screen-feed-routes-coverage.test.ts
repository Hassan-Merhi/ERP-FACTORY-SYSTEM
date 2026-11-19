/**
 * Screen feed routes (server/routes/screenFeedRoutes.ts) with auth and named
 * permissions mocked, and the tenant gate and watch-audit service mocked at
 * their module boundaries: Developer-only runtime admin, controller-only
 * viewing, tenant-gate refusals, feature flags off, oversized or malformed
 * legacy frames, pointer/failure beacons, and the legacy SSE streams.
 */
import type { NextFunction, Request, Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readEventStream, sessionApp, type RouteSession } from "./helpers/remoteSupportRouteApp";

vi.mock("../server/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireLogin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock("../server/lib/permissionMiddleware", () => ({
  requireActionAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
const gate = vi.hoisted(() => ({ allowed: true, watches: [] as string[] }));
vi.mock("../server/services/screenFeedTenantGate", () => ({
  assertScreenFeedTenantAccess: async () =>
    gate.allowed
      ? { allowed: true, companyId: 7, source: "presence" }
      : { allowed: false, status: 403, message: "Not in your company." },
  setScreenFeedPresenceLookupForTests: () => undefined,
}));
vi.mock("../server/services/screenWatchAuditService", () => ({
  beginScreenWatch: async (input: { targetUserId: string }) => {
    gate.watches.push(`begin:${input.targetUserId}`);
    return { watchId: "w", started: true };
  },
  endScreenWatch: async (input: { targetUserId: string }) => {
    gate.watches.push(`end:${input.targetUserId}`);
    return true;
  },
  endAllScreenWatchesForController: async () => 0,
  endAllScreenWatchesForTarget: async () => 0,
  expireStaleScreenWatches: async () => 0,
  resetScreenWatchAuditStateForTests: () => undefined,
}));

const { registerScreenFeedRoutes } = await import("../server/routes/screenFeedRoutes");
const store = await import("../server/screenFeedStore");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags, isRemoteSupportEnabled } =
  await import("../server/services/remoteSupportRuntime");
const sessions = await import("../server/services/remoteControlSessionService");

const DEV: RouteSession = { userId: "1", username: "dev", currentRole: "Developer", currentCompanyId: 7 };
const MANAGER: RouteSession = { userId: "2", username: "boss", currentRole: "Manager", currentCompanyId: 7 };
const STAFF: RouteSession = { userId: "22", username: "employee", currentRole: "Staff", currentCompanyId: 7 };
const app = (session: RouteSession) => sessionApp(session, registerScreenFeedRoutes);
const allOn = {
  screenFeedEnabled: true,
  fastScreenFeed: true,
  remoteControl: true,
  keyboardControl: true,
  sensitiveActionProtection: true,
};
const key = (userId: string, tabId = "tab-1") => store.screenFeedStoreKey(userId, tabId);
const watch = (userId = "22", tabId = "tab-1") => store.watcherPollStore.set(key(userId, tabId), Date.now());

function frame() {
  return {
    userId: "22",
    username: "employee",
    tabId: "tab-1",
    dataUrl: "data:image/jpeg;base64,AA",
    capturedAt: new Date(),
    clicks: [],
    cursor: null,
  };
}

function clearStores() {
  store.screenFeedStore.clear();
  store.screenFeedCursorStore.clear();
  store.screenFeedFailureStore.clear();
  store.watcherPollStore.clear();
}

beforeEach(() => {
  gate.allowed = true;
  gate.watches = [];
  clearStores();
  sessions.resetRemoteControlSessionStateForTests();
  updateRemoteSupportFlags(allOn, "screen-feed-routes-coverage");
});
afterEach(() => {
  clearStores();
  sessions.resetRemoteControlSessionStateForTests();
  restoreRemoteSupportBootDefaults("screen-feed-routes-coverage-cleanup");
});

describe("runtime administration", () => {
  it("is Developer-only", async () => {
    const manager = app(MANAGER);
    for (const [method, path] of [
      ["get", "/api/screen-feed/admin/runtime"],
      ["get", "/api/screen-feed/admin/audit-queue-health"],
      ["patch", "/api/screen-feed/admin/runtime"],
      ["post", "/api/screen-feed/admin/runtime/emergency-stop"],
      ["post", "/api/screen-feed/admin/runtime/restore-defaults"],
      ["post", "/api/screen-feed/admin/runtime/reset-metrics"],
    ] as const) {
      expect((await request(manager)[method](path).send({})).status, path).toBe(403);
    }
    expect(isRemoteSupportEnabled("screenFeedEnabled")).toBe(true);
  });

  it("reads, patches, emergency-stops, restores and resets the runtime", async () => {
    const dev = app(DEV);
    const runtime = await request(dev).get("/api/screen-feed/admin/runtime");
    expect(runtime.body.flags).toMatchObject(allOn);
    expect(runtime.body.commandAuditQueue).toBeDefined();
    expect((await request(dev).get("/api/screen-feed/admin/audit-queue-health")).status).toBe(200);

    watch();
    store.screenFeedFailureStore.set(key("22"), { stage: "encode", reason: "x", occurredAt: new Date() });
    const off = await request(dev)
      .patch("/api/screen-feed/admin/runtime")
      .send({ flags: { screenFeedEnabled: false, remoteControl: false } });
    expect(off.body.flags.screenFeedEnabled).toBe(false);
    expect(store.watcherPollStore.size).toBe(0);
    expect(store.screenFeedFailureStore.size).toBe(0);

    const fastOnly = await request(dev).patch("/api/screen-feed/admin/runtime").send({ screenFeedEnabled: true });
    expect(fastOnly.body.flags.screenFeedEnabled).toBe(true);

    watch();
    const stopped = await request(dev).post("/api/screen-feed/admin/runtime/emergency-stop");
    expect(stopped.body.flags.screenFeedEnabled).toBe(false);
    expect(store.watcherPollStore.size).toBe(0);
    expect((await request(dev).post("/api/screen-feed/admin/runtime/restore-defaults")).status).toBe(200);
    expect((await request(dev).post("/api/screen-feed/admin/runtime/reset-metrics")).status).toBe(200);
  });
});

describe("watched-user beacons", () => {
  it("reports watch status, honouring the feature flag", async () => {
    const staff = app(STAFF);
    expect((await request(staff).get("/api/screen-feed/being-watched?tabId=tab-1")).body).toMatchObject({
      watched: false,
      fast: true,
      lastWatcherPollAgeMs: null,
    });
    watch();
    expect((await request(staff).get("/api/screen-feed/being-watched?tabId=tab-1")).body.watched).toBe(true);
    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-routes-coverage");
    expect((await request(staff).get("/api/screen-feed/being-watched")).body).toEqual({ watched: false, fast: false });
    expect((await request(staff).get("/api/screen-feed/trace/click?d=1")).status).toBe(204);
    expect((await request(staff).get("/api/screen-feed/trace/open")).status).toBe(204);
  });

  it("stores pointers and failures only while watched", async () => {
    const staff = app(STAFF);
    const cursor = { x: 0.25, y: 0.5, ts: Date.now() };
    expect((await request(staff).post("/api/screen-feed/pointer").send({ tabId: "tab-1", cursor })).status).toBe(204);
    expect(store.screenFeedCursorStore.size).toBe(0);
    watch();
    await request(staff)
      .post("/api/screen-feed/pointer")
      .send({ tabId: "tab-1", failure: { stage: "encode", reason: "Canvas tainted", durationMs: 5 } });
    expect(store.screenFeedFailureStore.get(key("22"))).toMatchObject({ stage: "encode" });
    await request(staff)
      .post("/api/screen-feed/pointer")
      .send({ tabId: "tab-1", cursor: { x: "bad" } });
    expect(store.screenFeedCursorStore.size).toBe(0);
    store.screenFeedStore.set(key("22"), frame());
    await request(staff)
      .post("/api/screen-feed/pointer")
      .send({ tabId: "tab-1", ...cursor });
    expect(store.screenFeedCursorStore.get(key("22"))).toMatchObject({ x: 0.25, y: 0.5 });
    expect(store.screenFeedStore.get(key("22"))?.cursor).toMatchObject({ x: 0.25 });
    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-routes-coverage");
    expect((await request(staff).post("/api/screen-feed/pointer").send({ cursor })).status).toBe(204);
  });

  it("validates and bounds legacy frame uploads", async () => {
    const staff = app(STAFF);
    expect((await request(staff).post("/api/screen-feed").send({ dataUrl: "javascript:alert(1)" })).status).toBe(400);
    const huge = `data:image/jpeg;base64,${"A".repeat(1_500_001)}`;
    expect((await request(staff).post("/api/screen-feed").send({ dataUrl: huge })).status).toBe(204);
    expect(store.screenFeedStore.size).toBe(0);

    store.screenFeedFailureStore.set(key("22"), { stage: "encode", reason: "old", occurredAt: new Date() });
    const ok = await request(staff)
      .post("/api/screen-feed")
      .send({
        tabId: "tab-1",
        dataUrl: "data:image/jpeg;base64,AAAA",
        cursor: { x: 0.1, y: 0.2, ts: Date.now() },
        clicks: [],
        viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 0 },
      });
    expect(ok.status).toBe(204);
    expect(store.screenFeedStore.get(key("22"))).toMatchObject({ username: "employee", tabId: "tab-1" });
    expect(store.screenFeedFailureStore.has(key("22"))).toBe(false);

    updateRemoteSupportFlags({ fastScreenFeed: false }, "screen-feed-routes-coverage");
    expect((await request(staff).post("/api/screen-feed").send({ dataUrl: "data:image/png;base64,BB" })).status).toBe(
      204
    );
    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-routes-coverage");
    expect((await request(staff).post("/api/screen-feed").send({ dataUrl: "x" })).status).toBe(200);
  });
});

describe("viewer routes", () => {
  it("limits capabilities and frames to controller roles", async () => {
    const staff = app(STAFF);
    expect((await request(staff).get("/api/screen-feed/capabilities")).status).toBe(403);
    expect((await request(staff).get("/api/screen-feed/22")).status).toBe(403);
    expect((await request(staff).get("/api/screen-feed/live/22")).status).toBe(403);
    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-routes-coverage");
    const caps = await request(app(MANAGER)).get("/api/screen-feed/capabilities");
    expect(caps.body.flags).toEqual({
      screenFeedEnabled: false,
      fastScreenFeed: false,
      remoteControl: false,
      keyboardControl: false,
    });
  });

  it("returns frames, failures or nothing, and refuses other tenants", async () => {
    const manager = app(MANAGER);
    gate.allowed = false;
    const refused = await request(manager).get("/api/screen-feed/22?tabId=tab-1");
    expect(refused.status).toBe(403);
    expect(store.watcherPollStore.size).toBe(0);
    gate.allowed = true;

    expect((await request(manager).get("/api/screen-feed/22?tabId=tab-1")).body).toBeNull();
    store.screenFeedFailureStore.set(key("22"), { stage: "upload", reason: "413", occurredAt: new Date() });
    expect((await request(manager).get("/api/screen-feed/22?tabId=tab-1")).body).toMatchObject({
      captureFailure: { stage: "upload", durationMs: null },
      tabId: "tab-1",
    });
    store.screenFeedStore.set(key("22"), frame());
    store.screenFeedCursorStore.set(key("22"), { x: 0.3, y: 0.4, ts: 1, visible: true });
    const latest = await request(manager).get("/api/screen-feed/22?tabId=tab-1");
    expect(latest.body).toMatchObject({
      username: "employee",
      cursor: { x: 0.3 },
      captureFailure: { stage: "upload" },
    });
    expect(gate.watches).toContain("begin:22");

    updateRemoteSupportFlags({ screenFeedEnabled: false }, "screen-feed-routes-coverage");
    expect((await request(manager).get("/api/screen-feed/22")).body).toBeNull();
  });

  it("streams live frames to controllers and status to the watched tab", async () => {
    const manager = app(MANAGER);
    gate.allowed = false;
    expect((await request(manager).get("/api/screen-feed/live/22?tabId=tab-1")).status).toBe(403);
    gate.allowed = true;
    store.screenFeedStore.set(key("22"), frame());
    store.screenFeedFailureStore.set(key("22"), { stage: "encode", reason: "x", occurredAt: new Date() });
    store.screenFeedCursorStore.set(key("22"), { x: 0.3, y: 0.4, ts: 1, visible: true });
    const live = await readEventStream(manager, "/api/screen-feed/live/22?tabId=tab-1", "event: cursor");
    expect(live.body).toContain("event: ready");
    expect(live.body).toContain("event: frame");
    expect(live.body).toContain("event: capture-failure");

    const staff = app(STAFF);
    const json = await request(staff).get("/api/screen-feed/live/status?tabId=tab-1");
    expect(json.body).toMatchObject({ fast: true, tabId: "tab-1" });
    const sse = await readEventStream(staff, "/api/screen-feed/live/status?tabId=tab-1", "event: status", {
      accept: "text/event-stream",
    });
    expect(sse.body).toContain('"fast":true');

    updateRemoteSupportFlags({ fastScreenFeed: false }, "screen-feed-routes-coverage");
    expect((await request(staff).get("/api/screen-feed/live/status")).status).toBe(204);
    expect((await request(manager).get("/api/screen-feed/live/22")).status).toBe(204);
  });
});
