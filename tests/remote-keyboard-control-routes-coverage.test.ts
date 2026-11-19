/**
 * Remote keyboard routes (server/routes/remoteKeyboardControlRoutes.ts) with
 * auth/permission middleware mocked and the remote-support audit writer mocked
 * at its module boundary: controller-role refusals, wrong-company sessions,
 * sensitive-route blocks, fail-closed auditing, rate limits, streams and
 * target acknowledgements.
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

const { registerRemoteKeyboardControlRoutes } = await import("../server/routes/remoteKeyboardControlRoutes");
const keyboard = await import("../server/services/remoteKeyboardCommandService");
const mouse = await import("../server/services/remoteControlCommandService");
const sessions = await import("../server/services/remoteControlSessionService");
const { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } =
  await import("../server/services/remoteSupportRollout");
const { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } =
  await import("../server/services/remoteSupportRuntime");
const auditQueue = await import("../server/services/remoteSupportCommandAuditQueue");

const CONTROLLER: RouteSession = { userId: "1", username: "dev", currentRole: "Developer", currentCompanyId: 7 };
const TARGET: RouteSession = { userId: "22", username: "employee", currentRole: "Staff", currentCompanyId: 7 };
const app = (session: RouteSession) => sessionApp(session, registerRemoteKeyboardControlRoutes);
const controller = (companyId = 7) =>
  app({ ...CONTROLLER, currentCompanyId: companyId, passwordConfirmedAt: Date.now() });
const path = (id: string, suffix: string) => `/api/screen-feed/control/sessions/${id}/${suffix}`;

/** A live session with mouse control enabled, which keyboard control requires. */
function startSession(route = "/dashboard") {
  sessions.registerRemoteControlTab({ userId: "22", username: "employee", tabId: "tab-1", companyId: 7, route });
  const session = sessions.startRemoteControlSession({
    targetUserId: "22",
    targetUsername: "employee",
    requestedTabId: "tab-1",
    controllerUserId: "1",
    controllerUsername: "dev",
    controllerRole: "Developer",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
  mouse.authorizeRemoteMouseControl({ sessionId: session.id, controllerUserId: "1", passwordConfirmedAt: Date.now() });
  return session;
}

function authorize(sessionId: string) {
  return keyboard.authorizeRemoteKeyboardControl({ sessionId, controllerUserId: "1", passwordConfirmedAt: Date.now() });
}

function listen(sessionId: string) {
  const received: unknown[] = [];
  keyboard.subscribeRemoteKeyboardCommands({
    sessionId,
    targetUserId: "22",
    targetTabId: "tab-1",
    listener: (command) => received.push(command),
  });
  return received;
}

beforeEach(() => {
  audit.fail = false;
  audit.events = [];
  resetRemoteSupportRolloutForTests();
  keyboard.resetRemoteKeyboardCommandStateForTests();
  mouse.resetRemoteMouseCommandStateForTests();
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
    "keyboard-routes-coverage"
  );
  updateRemoteSupportRollout({ stage: "general" }, "keyboard-routes-coverage");
});

afterEach(() => {
  auditQueue.resetRemoteSupportCommandAuditQueueForTests();
  keyboard.resetRemoteKeyboardCommandStateForTests();
  mouse.resetRemoteMouseCommandStateForTests();
  sessions.resetRemoteControlSessionStateForTests();
  resetRemoteSupportRolloutForTests();
  restoreRemoteSupportBootDefaults("keyboard-routes-coverage-cleanup");
});

describe("keyboard authorization", () => {
  it("refuses non-controllers on every controller route", async () => {
    const session = startSession();
    const staff = app(TARGET);
    for (const [method, suffix] of [
      ["post", "keyboard-authorization"],
      ["post", "keyboard-authorization/revoke"],
      ["post", "keyboard-commands"],
      ["get", "keyboard-results"],
    ] as const) {
      expect((await request(staff)[method](path(session.id, suffix)).send({})).status, suffix).toBe(403);
    }
    expect(audit.events).toEqual([]);
  });

  it("authorizes only with a fresh password, in the same company, with a writable audit", async () => {
    const session = startSession();
    const noPassword = await request(app(CONTROLLER)).post(path(session.id, "keyboard-authorization"));
    expect(noPassword.status).toBeGreaterThanOrEqual(400);
    expect(noPassword.body.code).toBeTruthy();

    expect((await request(controller(8)).post(path(session.id, "keyboard-authorization"))).status).toBe(404);
    expect(keyboard.getRemoteKeyboardAuthorization(session.id, "1")).toBeNull();

    audit.fail = true;
    const unaudited = await request(controller()).post(path(session.id, "keyboard-authorization"));
    expect(unaudited.status).toBe(503);
    expect(keyboard.getRemoteKeyboardAuthorization(session.id, "1")).toBeNull();

    audit.fail = false;
    const ok = await request(controller()).post(path(session.id, "keyboard-authorization"));
    expect(ok.status).toBe(200);
    expect(ok.body.authorization).toMatchObject({ sessionId: session.id });
    expect(audit.events).toEqual(["keyboard_authorized", "keyboard_authorized"]);
  });

  it("revokes for the session company and surfaces audit errors", async () => {
    const session = startSession();
    authorize(session.id);
    expect((await request(controller(8)).post(path(session.id, "keyboard-authorization/revoke"))).status).toBe(404);
    expect((await request(controller()).post(path("missing", "keyboard-authorization/revoke"))).status).toBe(404);
    audit.fail = true;
    const failed = await request(controller()).post(path(session.id, "keyboard-authorization/revoke"));
    expect(failed.status).toBe(500);
    expect(keyboard.getRemoteKeyboardAuthorization(session.id, "1")).toBeNull();
    audit.fail = false;
    const ok = await request(controller()).post(path(session.id, "keyboard-authorization/revoke"));
    expect(ok.body).toEqual({ authorization: null });
  });
});

describe("keyboard commands", () => {
  it("refuses unknown sessions, other companies and sensitive routes", async () => {
    expect((await request(controller()).post(path("missing", "keyboard-commands")).send({})).status).toBe(404);
    const session = startSession("/settings/users");
    expect((await request(controller(8)).post(path(session.id, "keyboard-commands")).send({})).status).toBe(404);
    const blocked = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "insert-text", text: "secret" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe("SENSITIVE_REMOTE_ACTION_BLOCKED");
    const invalid = await request(controller()).post(path(session.id, "keyboard-commands")).send({ type: 5 });
    expect(invalid.status).toBe(403);
    expect(audit.events).toEqual(["command_blocked", "command_blocked"]);
  });

  it("refuses without authorization or a listening tab, then publishes text and keys", async () => {
    const session = startSession();
    const unauthorized = await request(controller()).post(path(session.id, "keyboard-commands")).send({ type: "key" });
    expect(unauthorized.status).toBeGreaterThanOrEqual(400);
    authorize(session.id);
    const noTab = await request(controller()).post(path(session.id, "keyboard-commands")).send({ type: "key" });
    expect(noTab.status).toBe(409);
    expect(noTab.body.code).toBe("TARGET_KEYBOARD_CHANNEL_UNAVAILABLE");

    const received = listen(session.id);
    const text = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "insert-text", text: "hello" });
    expect(text.status).toBe(202);
    const key = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "key", key: "Enter", shiftKey: true });
    expect(key.status).toBe(202);
    expect(received).toHaveLength(2);
    const bad = await request(controller()).post(path(session.id, "keyboard-commands")).send({ type: "macro" });
    expect(bad.status).toBe(400);
  });

  it("rate limits bursts with a retry hint", async () => {
    const session = startSession();
    authorize(session.id);
    listen(session.id);
    let limited: request.Response | null = null;
    for (let i = 0; i < 200 && !limited; i++) {
      const res = await request(controller())
        .post(path(session.id, "keyboard-commands"))
        .send({ type: "insert-text", text: "a" });
      if (res.status === 429) limited = res;
    }
    expect(limited?.headers["retry-after"]).toBeTruthy();
    expect(limited?.body.retryAfterMs).toBeGreaterThan(0);
  });

  it("fails closed when the audit queue cannot accept rows", async () => {
    const session = startSession();
    authorize(session.id);
    listen(session.id);
    auditQueue.setRemoteSupportCommandAuditWriterForTests(async () => {
      throw new Error("audit database unavailable");
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await request(controller()).post(path(session.id, "keyboard-commands")).send({ type: "key", key: "Tab" });
      await auditQueue.flushRemoteSupportCommandAudits();
    }
    const blocked = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "key", key: "Tab" });
    expect(blocked.status).toBe(503);
    expect(blocked.body.code).toBe("REMOTE_SUPPORT_AUDIT_UNAVAILABLE");
  });
});

describe("keyboard streams and results", () => {
  it("streams commands to the target and results to the controller", async () => {
    const target = app(TARGET);
    expect((await request(target).get("/api/screen-feed/control/keyboard-commands?tabId=tab-1")).status).toBe(400);
    expect(
      (await request(target).get("/api/screen-feed/control/keyboard-commands?sessionId=x&tabId=tab-1")).status
    ).toBe(409);
    const session = startSession();
    authorize(session.id);
    const ready = await readEventStream(
      target,
      `/api/screen-feed/control/keyboard-commands?sessionId=${session.id}&tabId=tab-1`
    );
    expect(ready.contentType).toContain("text/event-stream");
    expect(ready.body).toContain("event: ready");
    expect((await request(controller()).get(path("x", "keyboard-results"))).status).toBe(409);
    const results = await readEventStream(controller(), path(session.id, "keyboard-results"));
    expect(results.body).toContain("event: ready");
  });

  it("records each acknowledgement from the target tab once", async () => {
    const session = startSession();
    authorize(session.id);
    listen(session.id);
    const sent = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "key", key: "Enter" });
    const commandId = sent.body.command.id;
    const target = app(TARGET);
    const missing = await request(target)
      .post(path(session.id, "keyboard-commands/nope/result"))
      .send({ tabId: "tab-1", status: "executed" });
    expect(missing.status).toBe(404);
    const done = await request(target)
      .post(path(session.id, `keyboard-commands/${commandId}/result`))
      .send({ tabId: "tab-1", status: "blocked", reason: "focus lost" });
    expect(done.status).toBe(200);
    expect(done.body.result).toMatchObject({ commandId, status: "blocked" });
    const replay = await request(target)
      .post(path(session.id, `keyboard-commands/${commandId}/result`))
      .send({ tabId: "tab-1", status: "executed" });
    expect(replay.status).toBe(404);
    const next = await request(controller())
      .post(path(session.id, "keyboard-commands"))
      .send({ type: "insert-text", text: "ok" });
    const executed = await request(target)
      .post(path(session.id, `keyboard-commands/${next.body.command.id}/result`))
      .send({ tabId: "tab-1", status: "executed" });
    expect(executed.body.result).toMatchObject({ status: "executed" });
  });
});
