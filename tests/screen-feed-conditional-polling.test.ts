import express, { type NextFunction, type Request, type Response } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireLogin: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock("../server/lib/permissionMiddleware", () => ({
  requireActionAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

// Frame routes now require a same-company presence/tab match. These tests are
// about conditional ETag polling, not tenant isolation, so the gate is stubbed.
vi.mock("../server/services/screenFeedTenantGate", () => ({
  assertScreenFeedTenantAccess: async () => ({ allowed: true, companyId: 1, source: "presence" }),
  setScreenFeedPresenceLookupForTests: () => undefined,
}));

vi.mock("../server/services/screenWatchAuditService", () => ({
  beginScreenWatch: async () => ({ watchId: "watch-test", started: false }),
  endScreenWatch: async () => false,
  endAllScreenWatchesForController: async () => 0,
  endAllScreenWatchesForTarget: async () => 0,
  expireStaleScreenWatches: async () => 0,
  resetScreenWatchAuditStateForTests: () => undefined,
}));

const { registerScreenFeedTransportHardening, resetScreenFeedTransportHardeningForTests } =
  await import("../server/routes/screenFeedTransportHardening");
const { registerScreenFeedRoutes } = await import("../server/routes/screenFeedRoutes");
const { screenFeedCursorStore, screenFeedFailureStore, screenFeedStore, watcherPollStore } =
  await import("../server/screenFeedStore");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } =
  await import("../server/services/remoteSupportRuntime");

const WATCHED_USER_ID = "employee-42";

function appForWatcher() {
  const app = express();
  app.use((req, _res, next) => {
    (req as Request & { session: Record<string, unknown> }).session = {
      userId: "1",
      username: "watcher",
      currentRole: "Manager",
      currentCompanyId: 1,
    };
    next();
  });
  registerScreenFeedTransportHardening(app);
  registerScreenFeedRoutes(app);
  return app;
}

function seedFrame() {
  screenFeedStore.set(WATCHED_USER_ID, {
    userId: WATCHED_USER_ID,
    username: "employee",
    dataUrl: "data:image/jpeg;base64,AAAABBBB",
    capturedAt: new Date("2026-09-16T12:00:00.000Z"),
    clicks: [],
    cursor: null,
  });
}

describe("screen feed conditional polling", () => {
  beforeEach(() => {
    resetScreenFeedTransportHardeningForTests();
    restoreRemoteSupportBootDefaults("conditional-poll-test");
    screenFeedStore.clear();
    screenFeedCursorStore.clear();
    screenFeedFailureStore.clear();
    watcherPollStore.clear();
  });

  afterEach(() => {
    resetScreenFeedTransportHardeningForTests();
    restoreRemoteSupportBootDefaults("conditional-poll-test-cleanup");
    screenFeedStore.clear();
    screenFeedCursorStore.clear();
    screenFeedFailureStore.clear();
    watcherPollStore.clear();
  });

  it("returns 304 for an unchanged frame even when live transport is disabled", async () => {
    // Fast transport off is the steady-state polling fallback, so it is the
    // path that needs the bandwidth-saving validator most.
    updateRemoteSupportFlags({ screenFeedEnabled: true, fastScreenFeed: false }, "conditional-poll-test");
    seedFrame();
    const app = appForWatcher();

    const initial = await request(app).get(`/api/screen-feed/${WATCHED_USER_ID}`);

    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({ dataUrl: "data:image/jpeg;base64,AAAABBBB" });
    expect(initial.headers.etag).toMatch(/^W\/"screen-feed-/);
    expect(initial.headers["cache-control"]).toBe("private, no-cache, must-revalidate");
    expect(initial.headers.vary).toContain("Cookie");
    expect(initial.headers["x-screen-feed-transport"]).toBe("legacy");

    const revalidated = await request(app)
      .get(`/api/screen-feed/${WATCHED_USER_ID}`)
      .set("If-None-Match", initial.headers.etag);

    expect(revalidated.status).toBe(304);
    expect(revalidated.text).toBe("");
    expect(revalidated.headers.etag).toBe(initial.headers.etag);
    expect(revalidated.headers["cache-control"]).toBe("private, no-cache, must-revalidate");
  });

  it("invalidates the validator when the frame representation changes", async () => {
    seedFrame();
    const app = appForWatcher();

    const initial = await request(app).get(`/api/screen-feed/${WATCHED_USER_ID}`);
    screenFeedStore.set(WATCHED_USER_ID, {
      ...screenFeedStore.get(WATCHED_USER_ID)!,
      dataUrl: "data:image/jpeg;base64,CCCCDDDD",
      capturedAt: new Date("2026-09-16T12:00:01.000Z"),
    });

    const refreshed = await request(app)
      .get(`/api/screen-feed/${WATCHED_USER_ID}`)
      .set("If-None-Match", initial.headers.etag);

    expect(refreshed.status).toBe(200);
    expect(refreshed.body.dataUrl).toBe("data:image/jpeg;base64,CCCCDDDD");
    expect(refreshed.headers.etag).not.toBe(initial.headers.etag);
  });
});
