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

const { registerRemoteControlSessionRoutes } = await import("../server/routes/remoteControlSessionRoutes");
const { authorizeRemoteMouseControl, resetRemoteMouseCommandStateForTests, subscribeRemoteMouseCommands } =
  await import("../server/services/remoteControlCommandService");
const { registerRemoteControlTab, resetRemoteControlSessionStateForTests, startRemoteControlSession } =
  await import("../server/services/remoteControlSessionService");
const { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } =
  await import("../server/services/remoteSupportRollout");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } =
  await import("../server/services/remoteSupportRuntime");
const {
  flushRemoteSupportCommandAudits,
  getRemoteSupportCommandAuditHealth,
  resetRemoteSupportCommandAuditQueueForTests,
  setRemoteSupportCommandAuditWriterForTests,
} = await import("../server/services/remoteSupportCommandAuditQueue");

function controllerApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: {
        userId: "1",
        username: "developer",
        currentRole: "Developer",
        currentCompanyId: 7,
        passwordConfirmedAt: Date.now(),
      },
    });
    next();
  });
  registerRemoteControlSessionRoutes(app);
  return app;
}

function startAuthorizedSession() {
  registerRemoteControlTab({
    userId: "22",
    username: "employee",
    tabId: "erp-tab-1",
    companyId: 7,
    route: "/dashboard",
  });
  const session = startRemoteControlSession({
    targetUserId: "22",
    targetUsername: "employee",
    requestedTabId: "erp-tab-1",
    controllerUserId: "1",
    controllerUsername: "developer",
    controllerRole: "Developer",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
  authorizeRemoteMouseControl({
    sessionId: session.id,
    controllerUserId: "1",
    passwordConfirmedAt: Date.now(),
  });
  return session;
}

describe("remote support Phase 10 — mouse command endpoint", () => {
  beforeEach(() => {
    resetRemoteSupportRolloutForTests();
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportCommandAuditQueueForTests();
    setRemoteSupportCommandAuditWriterForTests(async () => undefined);
    updateRemoteSupportFlags(
      {
        screenFeedEnabled: true,
        fastScreenFeed: true,
        remoteControl: true,
        keyboardControl: false,
        sensitiveActionProtection: true,
      },
      "phase-10-route-test"
    );
    updateRemoteSupportRollout({ stage: "general" }, "phase-10-route-test");
  });

  afterEach(() => {
    resetRemoteSupportCommandAuditQueueForTests();
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportRolloutForTests();
    restoreRemoteSupportBootDefaults("phase-10-route-test-cleanup");
  });

  it("accepts a command without waiting for the audit write", async () => {
    const session = startAuthorizedSession();
    const releases: (() => void)[] = [];
    setRemoteSupportCommandAuditWriterForTests(
      async () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        })
    );

    const response = await request(controllerApp())
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "click", x: 0.5, y: 0.5 });

    // The 202 is returned while the audit row is still only queued.
    expect(response.status).toBe(202);
    expect(response.body.command).toMatchObject({ type: "click", sequence: 1 });
    expect(getRemoteSupportCommandAuditHealth().writtenRecords).toBe(0);

    const flush = flushRemoteSupportCommandAudits();
    await Promise.resolve();
    for (const release of releases) release();
    await flush;
    expect(getRemoteSupportCommandAuditHealth().writtenRecords).toBe(1);
  });

  it("reports superseded pointer moves to the controller", async () => {
    const session = startAuthorizedSession();
    const app = controllerApp();

    const first = await request(app)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "pointer-move", x: 0.1, y: 0.1 });
    const second = await request(app)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "pointer-move", x: 0.2, y: 0.2 });

    expect(first.body.supersededCommandIds).toEqual([]);
    expect(second.body.supersededCommandIds).toEqual([first.body.command.id]);
  });

  it("refuses a rate-limited command with 429 and a retry hint, without queueing it", async () => {
    const session = startAuthorizedSession();
    const app = controllerApp();

    for (let index = 0; index < 4; index += 1) {
      const allowed = await request(app)
        .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
        .send({ type: "click", x: 0.5, y: 0.5 });
      expect(allowed.status).toBe(202);
    }

    const refused = await request(app)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "click", x: 0.5, y: 0.5 });

    expect(refused.status).toBe(429);
    expect(refused.body.code).toBe("COMMAND_RATE_LIMITED");
    expect(refused.body.retryAfterMs).toBeGreaterThan(0);
    expect(refused.headers["retry-after"]).toBeDefined();

    // Exactly the four admitted clicks reached the target tab.
    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it("writes no audit row for a command it refuses", async () => {
    const session = startAuthorizedSession();
    const app = controllerApp();
    const rows: unknown[] = [];
    setRemoteSupportCommandAuditWriterForTests(async (batch) => {
      rows.push(...batch);
    });

    for (let index = 0; index < 4; index += 1) {
      await request(app)
        .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
        .send({ type: "click", x: 0.5, y: 0.5 });
    }
    await request(app)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "click", x: 0.5, y: 0.5 });
    await flushRemoteSupportCommandAudits();

    expect(rows).toHaveLength(4);
  });

  it("blocks control when the audit queue can no longer promise a record", async () => {
    const session = startAuthorizedSession();
    const app = controllerApp();
    setRemoteSupportCommandAuditWriterForTests(async () => {
      throw new Error("audit database unavailable");
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(app)
        .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
        .send({ type: "pointer-move", x: 0.5, y: 0.5 });
      await flushRemoteSupportCommandAudits();
    }

    const blocked = await request(app)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "pointer-move", x: 0.6, y: 0.6 });

    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe("REMOTE_SUPPORT_AUDIT_UNAVAILABLE");
  });
});
