/**
 * Remote-control session routes (server/routes/remoteControlSessionRoutes.ts)
 * with auth/permission middleware mocked and the remote-support audit writer
 * mocked at its module boundary: controller-role refusals, wrong-company
 * sessions, audit-unavailable fail-closed paths, SSE streams, command results
 * and emergency stop.
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
const audit = vi.hoisted(() => ({ fail: false, events: [] as string[] }));
vi.mock("../server/services/remoteSupportAuditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/remoteSupportAuditService")>()),
  writeRemoteSupportAudit: async (input: { event: string }) => {
    audit.events.push(input.event);
    if (audit.fail) throw new Error("audit db down");
  },
}));

const { registerRemoteControlSessionRoutes } = await import("../server/routes/remoteControlSessionRoutes");
const commands = await import("../server/services/remoteControlCommandService");
const sessions = await import("../server/services/remoteControlSessionService");
const { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } =
  await import("../server/services/remoteSupportRollout");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } =
  await import("../server/services/remoteSupportRuntime");
const auditQueue = await import("../server/services/remoteSupportCommandAuditQueue");

const CONTROLLER: RouteSession = {
  userId: "1",
  username: "dev",
  currentRole: "Developer",
  currentCompanyId: 7,
  passwordConfirmedAt: Date.now(),
};
const TARGET: RouteSession = { userId: "22", username: "employee", currentRole: "Staff", currentCompanyId: 7 };
const app = (session: RouteSession) => sessionApp(session, registerRemoteControlSessionRoutes);
const controller = () => app({ ...CONTROLLER, passwordConfirmedAt: Date.now() });

function startSession(route = "/dashboard") {
  sessions.registerRemoteControlTab({ userId: "22", username: "employee", tabId: "tab-1", companyId: 7, route });
  return sessions.startRemoteControlSession({
    targetUserId: "22",
    targetUsername: "employee",
    requestedTabId: "tab-1",
    controllerUserId: "1",
    controllerUsername: "dev",
    controllerRole: "Developer",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
}

beforeEach(() => {
  audit.fail = false;
  audit.events = [];
  resetRemoteSupportRolloutForTests();
  commands.resetRemoteMouseCommandStateForTests();
  sessions.resetRemoteControlSessionStateForTests();
  auditQueue.resetRemoteSupportCommandAuditQueueForTests();
  auditQueue.setRemoteSupportCommandAuditWriterForTests(async () => undefined);
  updateRemoteSupportFlags(
    {
      screenFeedEnabled: true,
      fastScreenFeed: true,
      remoteControl: true,
      keyboardControl: true,
      sensitiveActionProtection: true,
    },
    "session-routes-coverage"
  );
  updateRemoteSupportRollout({ stage: "general" }, "session-routes-coverage");
});

afterEach(() => {
  auditQueue.resetRemoteSupportCommandAuditQueueForTests();
  commands.resetRemoteMouseCommandStateForTests();
  sessions.resetRemoteControlSessionStateForTests();
  resetRemoteSupportRolloutForTests();
  restoreRemoteSupportBootDefaults("session-routes-coverage-cleanup");
});

describe("controller-only reads", () => {
  it("refuses non-controller roles on every controller route", async () => {
    const staff = app(TARGET);
    const session = startSession();
    for (const [method, path] of [
      ["get", "/api/screen-feed/control/tabs/22"],
      ["get", "/api/screen-feed/control/sessions/controller-active"],
      ["get", "/api/screen-feed/control/sessions/active/22"],
      ["post", "/api/screen-feed/control/sessions"],
      ["post", `/api/screen-feed/control/sessions/${session.id}/heartbeat`],
      ["post", `/api/screen-feed/control/sessions/${session.id}/mouse-authorization`],
      ["post", `/api/screen-feed/control/sessions/${session.id}/mouse-authorization/revoke`],
      ["post", `/api/screen-feed/control/sessions/${session.id}/commands`],
      ["get", `/api/screen-feed/control/sessions/${session.id}/results`],
    ] as const) {
      const res = await request(staff)[method](path).send({});
      expect(res.status, path).toBe(403);
    }
    expect(audit.events).toEqual([]);
  });

  it("lists tabs and sessions only for the controller's company", async () => {
    const session = startSession();
    const tabs = await request(controller()).get("/api/screen-feed/control/tabs/22");
    expect(tabs.body.tabs).toEqual([expect.objectContaining({ tabId: "tab-1" })]);

    const active = await request(controller()).get("/api/screen-feed/control/sessions/controller-active");
    expect(active.body.sessions).toEqual([
      expect.objectContaining({ id: session.id, mouseAuthorization: null, keyboardAuthorization: null }),
    ]);
    const otherCompany = app({ ...CONTROLLER, currentCompanyId: 8 });
    expect(
      (await request(otherCompany).get("/api/screen-feed/control/sessions/controller-active")).body.sessions
    ).toEqual([]);
    expect((await request(controller()).get("/api/screen-feed/control/sessions/active/22")).body.session.id).toBe(
      session.id
    );
    expect((await request(otherCompany).get("/api/screen-feed/control/sessions/active/22")).body.session).toBeNull();
  });
});

describe("session lifecycle", () => {
  it("starts a session, and stops it again when the audit cannot be written", async () => {
    sessions.registerRemoteControlTab({ userId: "22", tabId: "tab-1", companyId: 7, route: "/sales" });
    audit.fail = true;
    const refused = await request(controller())
      .post("/api/screen-feed/control/sessions")
      .send({ targetUserId: "22", tabId: "tab-1", durationMinutes: 5 });
    expect(refused.status).toBe(503);
    expect(refused.body.code).toBe("REMOTE_SUPPORT_AUDIT_UNAVAILABLE");
    expect(sessions.getActiveRemoteControlSession("22")).toBeNull();

    audit.fail = false;
    const started = await request(controller())
      .post("/api/screen-feed/control/sessions")
      .send({ targetUserId: "22", tabId: "tab-1", durationMinutes: "abc" });
    expect(started.status).toBe(201);
    expect(started.body.session).toMatchObject({ targetUserId: "22", targetRoute: "/sales" });
    expect(audit.events).toEqual(["session_started", "session_started"]);
  });

  it("maps service refusals to their status codes", async () => {
    updateRemoteSupportFlags({ remoteControl: false }, "session-routes-coverage");
    const disabled = await request(controller()).post("/api/screen-feed/control/sessions").send({ targetUserId: "22" });
    expect(disabled.status).toBe(409);
    expect(disabled.body.code).toBe("REMOTE_CONTROL_DISABLED");

    const badTab = await request(app(TARGET)).post("/api/screen-feed/control/tab-heartbeat").send({ tabId: "" });
    expect(badTab.status).toBe(400);
    expect(badTab.body.code).toBe("INVALID_TAB");
  });

  it("refreshes the controller heartbeat only for a live session in the same company", async () => {
    const session = startSession();
    expect((await request(controller()).post("/api/screen-feed/control/sessions/nope/heartbeat")).status).toBe(404);
    const other = app({ ...CONTROLLER, currentCompanyId: 8 });
    expect((await request(other).post(`/api/screen-feed/control/sessions/${session.id}/heartbeat`)).status).toBe(404);
    const ok = await request(controller()).post(`/api/screen-feed/control/sessions/${session.id}/heartbeat`);
    expect(ok.status).toBe(200);
    expect(ok.body.session.id).toBe(session.id);
  });

  it("lets the target, the controller or another controller role stop a session", async () => {
    expect((await request(app(TARGET)).post("/api/screen-feed/control/sessions/none/stop")).status).toBe(404);
    let session = startSession();
    const stranger = app({ userId: "99", currentRole: "Staff", currentCompanyId: 7 });
    expect((await request(stranger).post(`/api/screen-feed/control/sessions/${session.id}/stop`)).status).toBe(403);

    const byTarget = await request(app(TARGET)).post(`/api/screen-feed/control/sessions/${session.id}/stop`).send({});
    expect(byTarget.body.session).toMatchObject({ stopReason: "target-emergency-stop" });

    session = startSession();
    audit.fail = true;
    const byController = await request(controller())
      .post(`/api/screen-feed/control/sessions/${session.id}/stop`)
      .send({ reason: "  finished helping  " });
    expect(byController.status).toBe(200);
    expect(byController.body.session).toMatchObject({ stopReason: "finished helping" });

    session = startSession();
    const manager = app({ userId: "5", currentRole: "Manager", currentCompanyId: 7 });
    const byManager = await request(manager).post(`/api/screen-feed/control/sessions/${session.id}/stop`).send({});
    expect(byManager.body.session).toMatchObject({ stopReason: "controller-stopped" });
    const again = await request(manager).post(`/api/screen-feed/control/sessions/${session.id}/stop`).send({});
    expect(again.body.session).toMatchObject({ id: session.id, stopReason: "controller-stopped" });
  });
});

describe("mouse authorization", () => {
  it("authorizes, refuses wrong company and audit outages, and revokes", async () => {
    const session = startSession();
    const base = `/api/screen-feed/control/sessions/${session.id}/mouse-authorization`;
    const other = app({ ...CONTROLLER, currentCompanyId: 8, passwordConfirmedAt: Date.now() });
    expect((await request(other).post(base)).status).toBe(404);
    expect(commands.getRemoteMouseAuthorization(session.id, "1")).toBeNull();

    audit.fail = true;
    expect((await request(controller()).post(base)).status).toBe(503);
    expect(commands.getRemoteMouseAuthorization(session.id, "1")).toBeNull();

    audit.fail = false;
    const ok = await request(controller()).post(base);
    expect(ok.status).toBe(200);
    expect(ok.body.authorization).toMatchObject({ sessionId: session.id });

    const unconfirmed = app({ ...CONTROLLER, passwordConfirmedAt: undefined });
    const stale = await request(unconfirmed).post(base);
    expect(stale.status).toBeGreaterThanOrEqual(400);

    expect((await request(other).post(`${base}/revoke`)).status).toBe(404);
    const revoked = await request(controller()).post(`${base}/revoke`);
    expect(revoked.body).toMatchObject({ authorization: null, session: { id: session.id } });
    expect(audit.events).toContain("mouse_revoked");
  });
});

describe("mouse commands and results", () => {
  it("blocks commands for unknown sessions and invalid types", async () => {
    const session = startSession();
    commands.authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: Date.now(),
    });
    expect((await request(controller()).post("/api/screen-feed/control/sessions/x/commands").send({})).status).toBe(
      404
    );
    const blocked = await request(controller())
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: { evil: true } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("SENSITIVE_REMOTE_ACTION_BLOCKED");
    expect(audit.events).toEqual(["command_blocked"]);
  });

  it("streams commands to the target tab and results to the controller", async () => {
    const target = app(TARGET);
    expect((await request(target).get("/api/screen-feed/control/commands?sessionId=x")).status).toBe(400);
    expect((await request(target).get("/api/screen-feed/control/commands?sessionId=x&tabId=tab-1")).status).toBe(409);
    const session = startSession();
    commands.authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: Date.now(),
    });
    const ready = await readEventStream(
      target,
      `/api/screen-feed/control/commands?sessionId=${session.id}&tabId=tab-1`
    );
    expect(ready.contentType).toContain("text/event-stream");
    expect(ready.body).toContain("event: ready");

    expect((await request(controller()).get("/api/screen-feed/control/sessions/x/results")).status).toBe(409);
    const results = await readEventStream(controller(), `/api/screen-feed/control/sessions/${session.id}/results`);
    expect(results.body).toContain(`"sessionId":"${session.id}"`);
  });

  it("records command results from the target and refuses unknown commands", async () => {
    const session = startSession();
    commands.authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: Date.now(),
    });
    const sent = await request(controller())
      .post(`/api/screen-feed/control/sessions/${session.id}/commands`)
      .send({ type: "click", x: 0.5, y: 0.5, frameViewport: { width: 100, height: 100 } });
    expect(sent.status).toBe(202);
    const commandId = sent.body.command.id;
    const target = app(TARGET);
    const missing = await request(target)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands/nope/result`)
      .send({ tabId: "tab-1", status: "executed" });
    expect(missing.status).toBe(404);
    const done = await request(target)
      .post(`/api/screen-feed/control/sessions/${session.id}/commands/${commandId}/result`)
      .send({ tabId: "tab-1", status: "blocked", reason: "sensitive" });
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({ commandId, status: "blocked" });
  });

  it("opens the target control status stream and requires a tab id", async () => {
    const target = app(TARGET);
    expect((await request(target).get("/api/screen-feed/control/status")).status).toBe(400);
    const noCompany = app({ userId: "22", currentRole: "Staff" });
    expect((await request(noCompany).get("/api/screen-feed/control/status?tabId=t")).status).toBeGreaterThanOrEqual(
      400
    );
    const session = startSession();
    const stream = await readEventStream(target, "/api/screen-feed/control/status?tabId=tab-1&route=/sales");
    expect(stream.body).toContain("event: control");
    expect(stream.body).toContain(session.id);
  });
});
