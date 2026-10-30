/**
 * The remote-control WebSocket channel. A controller binds to a support
 * session and sends mouse and keyboard commands; the target ERP tab binds to
 * the same session and reports results. Every message is checked against the
 * in-memory session (owner, company, exact tab, granted capabilities), sensitive
 * routes refuse clicks and typing, and nothing is published unless its audit
 * row is accepted. Sessions and command services are real; only the audit
 * writers are replaced.
 */
const audit = vi.hoisted(() => ({
  accepting: true,
  accept: true,
  queued: [] as Array<{ event: string; details: Record<string, unknown> }>,
  blocked: vi.fn(),
}));

vi.mock("../server/services/remoteSupportCommandAuditQueue", () => ({
  isRemoteSupportCommandAuditAccepting: () => audit.accepting,
  enqueueRemoteSupportCommandAudit: (row: { event: string; details: Record<string, unknown> }) => {
    audit.queued.push(row);
    return audit.accept;
  },
}));
vi.mock("../server/services/remoteSupportAuditService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/remoteSupportAuditService")>()),
  writeRemoteSupportAudit: audit.blocked,
}));

import type { WebSocket } from "ws";
import {
  cleanupRemoteControlWebSocket,
  handleRemoteControlWebSocketMessage,
} from "../server/services/remoteControlWebSocketTransport";
import {
  authorizeRemoteMouseControl,
  resetRemoteMouseCommandStateForTests,
} from "../server/services/remoteControlCommandService";
import {
  authorizeRemoteKeyboardControl,
  resetRemoteKeyboardCommandStateForTests,
} from "../server/services/remoteKeyboardCommandService";
import {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
  startRemoteControlSession,
  stopRemoteControlSession,
} from "../server/services/remoteControlSessionService";
import { updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";
import { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } from "../server/services/remoteSupportRollout";

type Sent = Record<string, unknown>;
function fakeSocket(open = true) {
  const sent: Sent[] = [];
  const socket = {
    readyState: open ? 1 : 3,
    send: vi.fn((payload: string) => sent.push(JSON.parse(payload))),
  } as unknown as WebSocket;
  return { socket, sent };
}

const controller = { userId: "1", username: "support", role: "Admin", companyId: 7 };
const target = { userId: "22", username: "employee", role: "Staff", companyId: 7 };

function startSession(route = "/sales") {
  registerRemoteControlTab({ userId: "22", username: "employee", tabId: "tab-1", companyId: 7, route });
  return startRemoteControlSession({
    targetUserId: "22",
    targetUsername: "employee",
    controllerUserId: "1",
    controllerUsername: "support",
    controllerRole: "Admin",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
}

function grant(sessionId: string, keyboard = false) {
  const now = Date.now();
  authorizeRemoteMouseControl({ sessionId, controllerUserId: "1", passwordConfirmedAt: now, now });
  if (keyboard) authorizeRemoteKeyboardControl({ sessionId, controllerUserId: "1", passwordConfirmedAt: now, now });
}

const send = (socket: WebSocket, context: typeof controller, message: Record<string, unknown>) =>
  handleRemoteControlWebSocketMessage(socket, context, { requestId: "r1", ...message });
const last = (sent: Sent[]) => sent[sent.length - 1];

beforeEach(() => {
  resetRemoteSupportRolloutForTests();
  resetRemoteKeyboardCommandStateForTests();
  resetRemoteMouseCommandStateForTests();
  resetRemoteControlSessionStateForTests();
  updateRemoteSupportFlags(
    {
      screenFeedEnabled: true,
      fastScreenFeed: true,
      remoteControl: true,
      keyboardControl: true,
      sensitiveActionProtection: true,
    },
    "transport-test"
  );
  updateRemoteSupportRollout({ stage: "general" }, "transport-test");
  audit.accepting = true;
  audit.accept = true;
  audit.queued = [];
  audit.blocked.mockReset().mockResolvedValue(undefined);
});

describe("binding", () => {
  it("binds the target tab and the controller, and leaves unknown messages to other handlers", async () => {
    const session = startSession();
    grant(session.id);
    const tab = fakeSocket();
    const ctl = fakeSocket();

    expect(
      await send(tab.socket, target, {
        type: "remote-control:bind-mouse-target",
        sessionId: session.id,
        tabId: "tab-1",
      })
    ).toBe(true);
    expect(last(tab.sent)).toMatchObject({ ok: true, binding: "mouse-target", tabId: "tab-1" });
    await send(ctl.socket, controller, { type: "remote-control:bind-mouse-controller", sessionId: session.id });
    expect(last(ctl.sent)).toMatchObject({ ok: true, binding: "mouse-controller" });

    expect(await send(tab.socket, target, { type: "screen-feed:cursor" })).toBe(false);
  });

  it.each([
    ["an unknown session", { sessionId: "nope", tabId: "tab-1" }, target, "SESSION_INACTIVE"],
    ["another tab", { tabId: "tab-2" }, target, "TARGET_MISMATCH"],
    ["another user", { tabId: "tab-1" }, { ...target, userId: "23" }, "TARGET_MISMATCH"],
    ["another company", { tabId: "tab-1" }, { ...target, companyId: 9 }, "TARGET_COMPANY_MISMATCH"],
  ])("refuses a target bind from %s", async (_label, fields, context, code) => {
    const session = startSession();
    const tab = fakeSocket();

    await send(tab.socket, context, { type: "remote-control:bind-mouse-target", sessionId: session.id, ...fields });

    expect(last(tab.sent)).toMatchObject({ ok: false, code });
  });

  it.each([
    ["a staff role", { ...controller, role: "Staff" }, "CONTROLLER_MISMATCH"],
    ["another controller", { ...controller, userId: "2" }, "CONTROLLER_MISMATCH"],
    ["another company", { ...controller, companyId: 9 }, "SESSION_COMPANY_MISMATCH"],
  ])("refuses a controller bind from %s", async (_label, context, code) => {
    const session = startSession();
    grant(session.id);
    const ctl = fakeSocket();

    await send(ctl.socket, context, { type: "remote-control:bind-mouse-controller", sessionId: session.id });

    expect(last(ctl.sent)).toMatchObject({ ok: false, code });
  });

  it("requires the mouse and keyboard to be granted before binding to them", async () => {
    const session = startSession();
    const ctl = fakeSocket();
    const tab = fakeSocket();

    await send(ctl.socket, controller, { type: "remote-control:bind-mouse-controller", sessionId: session.id });
    expect(last(ctl.sent)).toMatchObject({ ok: false, status: 428, code: "MOUSE_AUTHORIZATION_REQUIRED" });

    grant(session.id);
    await send(ctl.socket, controller, { type: "remote-control:bind-keyboard-controller", sessionId: session.id });
    expect(last(ctl.sent)).toMatchObject({ code: "KEYBOARD_AUTHORIZATION_REQUIRED" });
    await send(tab.socket, target, {
      type: "remote-control:bind-keyboard-target",
      sessionId: session.id,
      tabId: "tab-1",
    });
    expect(last(tab.sent)).toMatchObject({ code: "KEYBOARD_AUTHORIZATION_REQUIRED" });
  });

  it("answers unbinds and sends nothing to a closed socket", async () => {
    const closed = fakeSocket(false);
    await send(closed.socket, controller, { type: "remote-control:unbind-keyboard-target", sessionId: "s" });
    expect(closed.socket.send).not.toHaveBeenCalled();

    const open = fakeSocket();
    await send(open.socket, controller, { type: "remote-control:unbind-keyboard-controller", sessionId: "s" });
    await handleRemoteControlWebSocketMessage(open.socket, controller, {
      type: "remote-control:unbind-keyboard-target",
    });
    expect(open.sent).toEqual([{ type: "remote-control:response", requestId: "r1", ok: true, sessionId: "s" }]);
  });
});

describe("mouse commands", () => {
  async function wired(route = "/sales") {
    const session = startSession(route);
    grant(session.id);
    const tab = fakeSocket();
    const ctl = fakeSocket();
    await send(tab.socket, target, { type: "remote-control:bind-mouse-target", sessionId: session.id, tabId: "tab-1" });
    await send(ctl.socket, controller, { type: "remote-control:bind-mouse-controller", sessionId: session.id });
    return { session, tab, ctl };
  }

  it("relays an audited click to the tab and the tab's result back to the controller", async () => {
    const { session, tab, ctl } = await wired();

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "click", x: 0.5, y: 0.25 },
    });
    const reply = last(ctl.sent) as { ok: boolean; command: { id: string; type: string; createdAt: string } };
    expect(reply).toMatchObject({ ok: true, command: { type: "click" } });
    expect(new Date(reply.command.createdAt).toISOString()).toBe(reply.command.createdAt);
    expect(last(tab.sent)).toMatchObject({ type: "remote-control:mouse-command", command: { id: reply.command.id } });
    expect(audit.queued.map((row) => row.event)).toEqual(["mouse_command"]);

    await send(tab.socket, target, {
      type: "remote-control:mouse-result",
      sessionId: session.id,
      tabId: "tab-1",
      commandId: reply.command.id,
      status: "executed",
    });
    expect(last(tab.sent)).toMatchObject({ ok: true, result: { status: "executed" } });
    expect(ctl.sent.some((m) => m.type === "remote-control:mouse-result")).toBe(true);
    expect(audit.queued.map((row) => row.event)).toEqual(["mouse_command", "mouse_result"]);
  });

  it("audits a blocked result as a blocked command", async () => {
    const { session, tab, ctl } = await wired();
    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "pointer-move", x: 0.1, y: 0.1 },
    });
    const { command } = last(ctl.sent) as { command: { id: string } };

    await send(tab.socket, target, {
      type: "remote-control:mouse-result",
      sessionId: session.id,
      tabId: "tab-1",
      commandId: command.id,
      status: "blocked",
      reason: "no-target",
    });

    expect(audit.queued.at(-1)).toMatchObject({
      event: "command_blocked",
      details: { capability: "mouse", status: "blocked" },
    });
  });

  it("blocks clicks on a sensitive route but still lets the pointer move there", async () => {
    const { session, ctl } = await wired("/settings/users");

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "click", x: 0.5, y: 0.5 },
    });
    expect(last(ctl.sent)).toMatchObject({ ok: false, status: 403, code: "SENSITIVE_REMOTE_ACTION_BLOCKED" });
    expect(audit.blocked).toHaveBeenCalledWith(expect.objectContaining({ event: "command_blocked" }));

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "pointer-move", x: 0.5, y: 0.5 },
    });
    expect(last(ctl.sent)).toMatchObject({ ok: true });
  });

  it("refuses an unknown command type and keeps denying when the denial audit fails", async () => {
    const { session, ctl } = await wired();
    audit.blocked.mockRejectedValue(new Error("db down"));

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: "drag",
    });

    expect(last(ctl.sent)).toMatchObject({ ok: false, code: "SENSITIVE_REMOTE_ACTION_BLOCKED" });
    expect(audit.blocked).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ commandType: "invalid" }) })
    );
  });

  it.each([
    ["is not accepting", () => (audit.accepting = false)],
    ["rejects the row", () => (audit.accept = false)],
  ])("does not publish while the audit queue %s", async (_label, breakAudit) => {
    const { session, tab, ctl } = await wired();
    breakAudit();
    const before = tab.sent.length;

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "click", x: 0.5, y: 0.5 },
    });

    expect(last(ctl.sent)).toMatchObject({
      ok: false,
      status: 503,
      code: "REMOTE_SUPPORT_AUDIT_UNAVAILABLE",
      retryAfterMs: 1000,
    });
    expect(tab.sent).toHaveLength(before);
  });

  it("refuses results from a tab that does not own the session, and commands after it stops", async () => {
    const { session, tab, ctl } = await wired();

    await send(tab.socket, target, {
      type: "remote-control:mouse-result",
      sessionId: session.id,
      tabId: "tab-9",
      commandId: "x",
      status: "executed",
    });
    expect(last(tab.sent)).toMatchObject({ ok: false, code: "TARGET_MISMATCH" });

    stopRemoteControlSession(session.id, "controller-stop");
    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "click", x: 0.5, y: 0.5 },
    });
    expect(last(ctl.sent)).toMatchObject({ ok: false, code: "SESSION_INACTIVE" });
  });

  it("stops relaying once the socket is cleaned up", async () => {
    const { session, tab, ctl } = await wired();
    cleanupRemoteControlWebSocket(tab.socket);
    const before = tab.sent.length;

    await send(ctl.socket, controller, {
      type: "remote-control:mouse-command",
      sessionId: session.id,
      command: { type: "click", x: 0.5, y: 0.5 },
    });

    expect(tab.sent).toHaveLength(before);
    cleanupRemoteControlWebSocket(fakeSocket().socket);
  });
});

describe("keyboard commands", () => {
  async function wired(route = "/sales") {
    const session = startSession(route);
    grant(session.id, true);
    const tab = fakeSocket();
    const ctl = fakeSocket();
    await send(tab.socket, target, {
      type: "remote-control:bind-keyboard-target",
      sessionId: session.id,
      tabId: "tab-1",
    });
    await send(ctl.socket, controller, { type: "remote-control:bind-keyboard-controller", sessionId: session.id });
    return { session, tab, ctl };
  }

  it("relays typed text with an audit row that never records the text itself in clear", async () => {
    const { session, tab, ctl } = await wired();

    await send(ctl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: session.id,
      command: { type: "insert-text", text: "hello" },
    });

    const reply = last(ctl.sent) as { ok: boolean; command: { id: string } };
    expect(reply).toMatchObject({ ok: true, command: { type: "insert-text" } });
    expect(last(tab.sent)).toMatchObject({
      type: "remote-control:keyboard-command",
      command: { id: reply.command.id },
    });
    expect(audit.queued[0]).toMatchObject({ event: "keyboard_command" });
    expect(JSON.stringify(audit.queued[0].details)).not.toContain("hello");

    await send(tab.socket, target, {
      type: "remote-control:keyboard-result",
      sessionId: session.id,
      tabId: "tab-1",
      commandId: reply.command.id,
      status: "executed",
    });
    expect(ctl.sent.some((m) => m.type === "remote-control:keyboard-result")).toBe(true);
    expect(audit.queued.at(-1)).toMatchObject({ event: "keyboard_result" });
  });

  it("blocks typing on a sensitive route", async () => {
    const { session, ctl } = await wired("/admin/permissions");

    await send(ctl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: session.id,
      command: { type: "key", key: "Enter" },
    });

    expect(last(ctl.sent)).toMatchObject({ ok: false, code: "SENSITIVE_REMOTE_ACTION_BLOCKED" });
    expect(audit.blocked).toHaveBeenCalledWith(
      expect.objectContaining({ details: expect.objectContaining({ capability: "keyboard" }) })
    );
  });

  it("refuses typing while no target tab listens, and while the audit queue is full", async () => {
    const session = startSession();
    grant(session.id, true);
    const ctl = fakeSocket();

    await send(ctl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: session.id,
      command: { type: "insert-text", text: "a" },
    });
    expect(last(ctl.sent)).toMatchObject({ ok: false, code: "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE" });

    const { session: wiredSession, ctl: wiredCtl } = await wired();
    audit.accepting = false;
    await send(wiredCtl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: wiredSession.id,
      command: { type: "insert-text", text: "a" },
    });
    expect(last(wiredCtl.sent)).toMatchObject({ code: "REMOTE_SUPPORT_AUDIT_UNAVAILABLE" });
  });

  it("audits a blocked keyboard result as a blocked command, and unbinds the target", async () => {
    const { session, tab, ctl } = await wired();
    await send(ctl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: session.id,
      command: { type: "key", key: "Tab" },
    });
    const { command } = last(ctl.sent) as { command: { id: string } };

    await send(tab.socket, target, {
      type: "remote-control:keyboard-result",
      sessionId: session.id,
      tabId: "tab-1",
      commandId: command.id,
      status: "blocked",
      reason: "no-focus",
    });
    expect(audit.queued.at(-1)).toMatchObject({ event: "command_blocked", details: { capability: "keyboard" } });

    await send(tab.socket, target, { type: "remote-control:unbind-keyboard-target", sessionId: session.id });
    await send(ctl.socket, controller, {
      type: "remote-control:keyboard-command",
      sessionId: session.id,
      command: { type: "key", key: "Tab" },
    });
    expect(last(ctl.sent)).toMatchObject({ code: "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE" });
  });

  it("refuses a result for a command the session never sent", async () => {
    const { session, tab } = await wired();

    await send(tab.socket, target, {
      type: "remote-control:keyboard-result",
      sessionId: session.id,
      tabId: "tab-1",
      commandId: "never-sent",
      status: "executed",
    });

    expect(last(tab.sent)).toMatchObject({ ok: false, status: 404, code: "KEYBOARD_COMMAND_NOT_FOUND" });
  });
});
