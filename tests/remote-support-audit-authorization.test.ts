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

const auditRows: Array<Record<string, unknown>> = [];

vi.mock("../server/db", () => ({
  db: {
    insert: () => ({
      values: async (row: Record<string, unknown> | Record<string, unknown>[]) => {
        if (Array.isArray(row)) auditRows.push(...row);
        else auditRows.push(row);
        return undefined;
      },
    }),
    select: () => {
      throw new Error("select should not be used — tenant gate is stubbed in these tests");
    },
  },
}));

const { registerScreenFeedRoutes } = await import("../server/routes/screenFeedRoutes");
const {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
} = await import("../server/services/remoteControlSessionService");
const {
  enqueueRemoteSupportCommandAudit,
  flushRemoteSupportCommandAudits,
  getRemoteSupportCommandAuditHealth,
  resetRemoteSupportCommandAuditQueueForTests,
  setRemoteSupportCommandAuditWriterForTests,
} = await import("../server/services/remoteSupportCommandAuditQueue");
const {
  beginScreenWatch,
  buildScreenWatchAuditRowForTests,
  endScreenWatch,
  getActiveScreenWatchCountForTests,
  resetScreenWatchAuditStateForTests,
} = await import("../server/services/screenWatchAuditService");
const {
  assertScreenFeedTenantAccess,
  setScreenFeedPresenceLookupForTests,
} = await import("../server/services/screenFeedTenantGate");
const { screenFeedStore, watcherPollStore } = await import("../server/screenFeedStore");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } =
  await import("../server/services/remoteSupportRuntime");
import type { RemoteControlSession } from "../server/services/remoteControlSessionService";

function sessionFixture(): RemoteControlSession {
  return {
    id: "session-agg-1",
    companyId: 7,
    targetUserId: "22",
    targetUsername: "employee",
    targetTabId: "tab-1",
    targetRoute: "/dashboard",
    controllerUserId: "1",
    controllerUsername: "manager",
    controllerRole: "Manager",
    scope: "erp-browser-tab",
    status: "active",
    startedAt: 1000,
    expiresAt: 601000,
    lastControllerHeartbeatAt: 1000,
    lastTargetHeartbeatAt: 1000,
    stoppedAt: null,
    stopReason: null,
    capabilities: { mouse: true, keyboard: false, browserTabOnly: true },
  };
}

function appFor(role: string, companyId: number | null = 7) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request & { session: Record<string, unknown> }).session = {
      userId: "controller-1",
      username: "watcher",
      currentRole: role,
      currentCompanyId: companyId,
    };
    next();
  });
  registerScreenFeedRoutes(app);
  return app;
}

describe("remote support audit + authorization", () => {
  beforeEach(() => {
    auditRows.length = 0;
    resetScreenWatchAuditStateForTests();
    resetRemoteSupportCommandAuditQueueForTests();
    resetRemoteControlSessionStateForTests();
    setScreenFeedPresenceLookupForTests(null);
    screenFeedStore.clear();
    watcherPollStore.clear();
    restoreRemoteSupportBootDefaults("audit-auth-test");
    updateRemoteSupportFlags(
      {
        screenFeedEnabled: true,
        fastScreenFeed: true,
        remoteControl: true,
        keyboardControl: true,
        sensitiveActionProtection: true,
      },
      "audit-auth-test"
    );
  });

  afterEach(() => {
    resetScreenWatchAuditStateForTests();
    resetRemoteSupportCommandAuditQueueForTests();
    resetRemoteControlSessionStateForTests();
    setScreenFeedPresenceLookupForTests(null);
    setRemoteSupportCommandAuditWriterForTests(null);
    screenFeedStore.clear();
    watcherPollStore.clear();
    restoreRemoteSupportBootDefaults("audit-auth-test-cleanup");
  });

  describe("screen_watch_started / screen_watch_ended", () => {
    it("writes started once and ended once for a watch pair", async () => {
      const first = await beginScreenWatch({
        companyId: 7,
        controllerUserId: "1",
        controllerUsername: "manager",
        controllerRole: "Manager",
        targetUserId: "22",
        targetUsername: "employee",
      });
      expect(first.started).toBe(true);

      const second = await beginScreenWatch({
        companyId: 7,
        controllerUserId: "1",
        controllerUsername: "manager",
        controllerRole: "Manager",
        targetUserId: "22",
      });
      expect(second.started).toBe(false);
      expect(second.watchId).toBe(first.watchId);
      expect(getActiveScreenWatchCountForTests()).toBe(1);

      const ended = await endScreenWatch({
        controllerUserId: "1",
        targetUserId: "22",
        stopReason: "viewer-closed",
      });
      expect(ended).toBe(true);
      expect(getActiveScreenWatchCountForTests()).toBe(0);

      const actions = auditRows.map((row) => row.action);
      expect(actions).toEqual([
        "remote_support_screen_watch_started",
        "remote_support_screen_watch_ended",
      ]);
      expect(auditRows[0]?.tableName).toBe("remote_support_sessions");
      expect(auditRows[0]?.companyId).toBe(7);
    });

    it("never stores frame or field content in the watch audit row", () => {
      const row = buildScreenWatchAuditRowForTests({
        event: "screen_watch_started",
        companyId: 7,
        controllerUserId: "1",
        controllerUsername: "manager",
        controllerRole: "Manager",
        targetUserId: "22",
        targetUsername: "employee",
        route: "/reports",
      });
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain("data:image");
      expect(serialized).not.toContain("password");
      expect(row.changes).toMatchObject({
        event: { new: "screen_watch_started" },
        capability: { new: "view" },
        scope: { new: "screen-watch" },
      });
    });
  });

  describe("tenant gate on frame routes", () => {
    it("allows a manager when the target is present in the same company", async () => {
      setScreenFeedPresenceLookupForTests(async () => 7);
      const gate = await assertScreenFeedTenantAccess({
        controllerRole: "Manager",
        controllerCompanyId: 7,
        watchedUserId: "22",
      });
      expect(gate).toMatchObject({ allowed: true, companyId: 7, source: "presence" });
    });

    it("blocks a manager when the target is only present in another company", async () => {
      setScreenFeedPresenceLookupForTests(async () => 9);
      const gate = await assertScreenFeedTenantAccess({
        controllerRole: "Manager",
        controllerCompanyId: 7,
        watchedUserId: "22",
      });
      expect(gate).toMatchObject({ allowed: false, status: 404 });
    });

    it("allows a manager when a live ERP tab is in the controller company", async () => {
      setScreenFeedPresenceLookupForTests(async () => null);
      registerRemoteControlTab({
        userId: "22",
        username: "employee",
        tabId: "erp-tab-1",
        companyId: 7,
        route: "/dashboard",
      });
      const gate = await assertScreenFeedTenantAccess({
        controllerRole: "Manager",
        controllerCompanyId: 7,
        watchedUserId: "22",
      });
      expect(gate).toMatchObject({ allowed: true, source: "tab" });
    });

    it("returns 404 from the frame route for a cross-tenant manager", async () => {
      setScreenFeedPresenceLookupForTests(async () => 9);
      screenFeedStore.set("22", {
        userId: "22",
        username: "employee",
        dataUrl: "data:image/jpeg;base64,AAAA",
        capturedAt: new Date(),
        clicks: [],
      });
      const response = await request(appFor("Manager", 7)).get("/api/screen-feed/22");
      expect(response.status).toBe(404);
      expect(response.body).not.toHaveProperty("dataUrl");
    });

    it("returns the frame for a same-company manager and records a watch start", async () => {
      setScreenFeedPresenceLookupForTests(async () => 7);
      screenFeedStore.set("22", {
        userId: "22",
        username: "employee",
        dataUrl: "data:image/jpeg;base64,AAAA",
        capturedAt: new Date(),
        clicks: [],
      });
      const response = await request(appFor("Manager", 7)).get("/api/screen-feed/22");
      expect(response.status).toBe(200);
      expect(response.body.dataUrl).toContain("data:image/jpeg");
      expect(auditRows.some((row) => row.action === "remote_support_screen_watch_started")).toBe(true);
    });
  });

  describe("aggregate pointer audit rows", () => {
    it("collapses consecutive pointer-moves for the same session into one row", async () => {
      const rows: Array<Record<string, unknown>> = [];
      setRemoteSupportCommandAuditWriterForTests(async (batch) => {
        rows.push(...batch);
      });
      const session = sessionFixture();

      for (let i = 0; i < 5; i += 1) {
        expect(
          enqueueRemoteSupportCommandAudit({
            event: "mouse_command",
            session,
            actorUserId: "1",
            actorUsername: "manager",
            details: {
              capability: "mouse",
              commandType: "pointer-move",
              route: "/dashboard",
              status: "requested",
            },
          })
        ).toBe(true);
      }

      // One pending aggregated row, four extra moves folded into pointerCount.
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(1);
      expect(getRemoteSupportCommandAuditHealth().aggregatedPointerMoves).toBe(4);

      await flushRemoteSupportCommandAudits();
      expect(rows).toHaveLength(1);
      const changes = rows[0]?.changes as Record<string, { new: unknown }>;
      expect(changes.commandType).toEqual({ new: "pointer-move" });
      expect(changes.pointerCount).toEqual({ new: 5 });
    });

    it("does not fold a click into a preceding pointer aggregate", async () => {
      const rows: Array<Record<string, unknown>> = [];
      setRemoteSupportCommandAuditWriterForTests(async (batch) => {
        rows.push(...batch);
      });
      const session = sessionFixture();

      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "pointer-move", status: "requested" },
      });
      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "pointer-move", status: "requested" },
      });
      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "click", status: "requested" },
      });
      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "pointer-move", status: "requested" },
      });

      await flushRemoteSupportCommandAudits();
      expect(rows).toHaveLength(3);
      const counts = rows.map((row) => {
        const changes = row.changes as Record<string, { new: unknown }>;
        return {
          type: changes.commandType?.new,
          pointerCount: changes.pointerCount?.new,
        };
      });
      expect(counts).toEqual([
        { type: "pointer-move", pointerCount: 2 },
        { type: "click", pointerCount: undefined },
        { type: "pointer-move", pointerCount: 1 },
      ]);
    });
  });

  describe("expose queue health", () => {
    it("includes commandAuditQueue on the developer runtime snapshot", async () => {
      const response = await request(appFor("Developer", 7)).get("/api/screen-feed/admin/runtime");
      expect(response.status).toBe(200);
      expect(response.body.commandAuditQueue).toMatchObject({
        pending: expect.any(Number),
        accepting: true,
        healthy: true,
        consecutiveFailures: 0,
        writtenRecords: expect.any(Number),
        aggregatedPointerMoves: expect.any(Number),
      });
    });

    it("exposes a dedicated audit-queue health endpoint for developers", async () => {
      const ok = await request(appFor("Developer", 7)).get("/api/screen-feed/admin/audit-queue-health");
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ accepting: true, healthy: true });

      const denied = await request(appFor("Manager", 7)).get("/api/screen-feed/admin/audit-queue-health");
      expect(denied.status).toBe(403);
    });
  });
});
