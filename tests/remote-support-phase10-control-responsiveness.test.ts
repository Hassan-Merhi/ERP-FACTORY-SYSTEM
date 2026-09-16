import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertRemoteMouseCommandAdmission,
  authorizeRemoteMouseControl,
  cleanupRemoteMouseCommandState,
  publishRemoteMouseCommand,
  publishRemoteMouseCommandResult,
  resetRemoteMouseCommandStateForTests,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
} from "../server/services/remoteControlCommandService";
import {
  assertRemoteKeyboardCommandAdmission,
  authorizeRemoteKeyboardControl,
  publishRemoteKeyboardCommand,
  resetRemoteKeyboardCommandStateForTests,
  subscribeRemoteKeyboardCommands,
} from "../server/services/remoteKeyboardCommandService";
import {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
  startRemoteControlSession,
  stopRemoteControlSession,
} from "../server/services/remoteControlSessionService";
import {
  installRemoteSupportSessionStopAudit,
  resetRemoteSupportAuditStateForTests,
} from "../server/services/remoteSupportAuditService";
import { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } from "../server/services/remoteSupportRollout";
import { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";
import {
  enqueueRemoteSupportCommandAudit,
  flushRemoteSupportCommandAudits,
  getRemoteSupportCommandAuditHealth,
  isRemoteSupportCommandAuditAccepting,
  resetRemoteSupportCommandAuditQueueForTests,
  setRemoteSupportCommandAuditWriterForTests,
} from "../server/services/remoteSupportCommandAuditQueue";
import type { RemoteControlSession } from "../server/services/remoteControlSessionService";

function buildSession(targetUserId = "22", tabId = "erp-tab-1") {
  const now = Date.now();
  registerRemoteControlTab({
    userId: targetUserId,
    username: `employee-${targetUserId}`,
    tabId,
    companyId: 7,
    route: "/dashboard",
    now,
  });
  const session = startRemoteControlSession({
    targetUserId,
    targetUsername: `employee-${targetUserId}`,
    requestedTabId: tabId,
    controllerUserId: "1",
    controllerUsername: "developer",
    controllerRole: "Developer",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
  authorizeRemoteMouseControl({
    sessionId: session.id,
    controllerUserId: "1",
    passwordConfirmedAt: now,
    now,
  });
  return { session, now };
}

function pointerMove(sessionId: string, x: number, now: number) {
  return publishRemoteMouseCommand({
    sessionId,
    controllerUserId: "1",
    type: "pointer-move",
    x,
    y: x,
    now,
  });
}

describe("remote support Phase 10 — control responsiveness", () => {
  beforeEach(() => {
    resetRemoteSupportRolloutForTests();
    resetRemoteMouseCommandStateForTests();
    resetRemoteKeyboardCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportCommandAuditQueueForTests();
    resetRemoteSupportAuditStateForTests();
    updateRemoteSupportFlags(
      {
        screenFeedEnabled: true,
        fastScreenFeed: true,
        remoteControl: true,
        keyboardControl: true,
        sensitiveActionProtection: true,
      },
      "phase-10-test"
    );
    updateRemoteSupportRollout({ stage: "general" }, "phase-10-test");
  });

  afterEach(() => {
    resetRemoteSupportCommandAuditQueueForTests();
    resetRemoteMouseCommandStateForTests();
    resetRemoteKeyboardCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportAuditStateForTests();
    resetRemoteSupportRolloutForTests();
    restoreRemoteSupportBootDefaults("phase-10-test-cleanup");
  });

  describe("superseded pointer moves are dropped from the queue", () => {
    it("keeps only the newest undelivered pointer move", () => {
      const { session, now } = buildSession();

      const first = pointerMove(session.id, 0.1, now + 1);
      const second = pointerMove(session.id, 0.2, now + 2);
      const third = pointerMove(session.id, 0.3, now + 3);

      expect(first.supersededCommandIds).toEqual([]);
      expect(second.supersededCommandIds).toEqual([first.command.id]);
      expect(third.supersededCommandIds).toEqual([second.command.id]);

      const listener = vi.fn();
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener,
      });

      // Reconnect replays the live position only, not the stale trail.
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].id).toBe(third.command.id);
      expect(listener.mock.calls[0][0].x).toBe(0.3);
    });

    it("reports each superseded move as ignored so the controller stays balanced", () => {
      const { session, now } = buildSession();
      const resultListener = vi.fn();
      subscribeRemoteMouseResults({ sessionId: session.id, controllerUserId: "1", listener: resultListener });

      const first = pointerMove(session.id, 0.1, now + 1);
      pointerMove(session.id, 0.2, now + 2);

      expect(resultListener).toHaveBeenCalledWith({
        commandId: first.command.id,
        sessionId: session.id,
        status: "ignored",
        reason: "superseded-pointer-move",
        completedAt: now + 2,
      });
    });

    it("never supersedes clicks or scrolls", () => {
      const { session, now } = buildSession();
      const click = publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "click",
        x: 0.5,
        y: 0.5,
        now: now + 1,
      });
      const scroll = publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "scroll",
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 120,
        now: now + 2,
      });
      const move = pointerMove(session.id, 0.9, now + 3);

      expect(move.supersededCommandIds).toEqual([]);

      const listener = vi.fn();
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener,
      });
      expect(listener.mock.calls.map(([command]) => command.id)).toEqual([
        click.command.id,
        scroll.command.id,
        move.command.id,
      ]);
    });

    it("never supersedes a pointer move the target tab already received", () => {
      const { session, now } = buildSession();
      const listener = vi.fn();
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener,
      });

      const delivered = pointerMove(session.id, 0.1, now + 1);
      const next = pointerMove(session.id, 0.2, now + 2);

      // The employee tab has already executed the first move, so overwriting
      // its result would contradict what actually happened on screen.
      expect(next.supersededCommandIds).toEqual([]);
      const acknowledged = publishRemoteMouseCommandResult({
        sessionId: session.id,
        commandId: delivered.command.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        status: "executed",
        now: now + 3,
      });
      expect(acknowledged.status).toBe("executed");
    });

    it("does not supersede pointer moves belonging to another session", () => {
      const first = buildSession("22", "erp-tab-1");
      const second = buildSession("23", "erp-tab-2");

      const firstMove = pointerMove(first.session.id, 0.1, first.now + 1);
      pointerMove(second.session.id, 0.4, second.now + 1);
      pointerMove(second.session.id, 0.5, second.now + 2);

      const listener = vi.fn();
      subscribeRemoteMouseCommands({
        sessionId: first.session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener,
      });
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener.mock.calls[0][0].id).toBe(firstMove.command.id);
    });

    it("leaves command timeout behavior intact for surviving commands", () => {
      const { session, now } = buildSession();
      const resultListener = vi.fn();
      subscribeRemoteMouseResults({ sessionId: session.id, controllerUserId: "1", listener: resultListener });
      const command = pointerMove(session.id, 0.5, now + 1);

      cleanupRemoteMouseCommandState(now + 15_002);

      expect(resultListener).toHaveBeenCalledWith({
        commandId: command.command.id,
        sessionId: session.id,
        status: "ignored",
        reason: "command-timeout",
        completedAt: now + 15_002,
      });
    });
  });

  describe("rate limiting fails fast instead of shipping dead commands", () => {
    it("refuses admission before a command is ever created", () => {
      const { session, now } = buildSession();
      for (let index = 0; index < 4; index += 1) {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        });
      }

      expect(() =>
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        })
      ).toThrowError(expect.objectContaining({ code: "COMMAND_RATE_LIMITED", statusCode: 429 }));

      // Nothing was queued for the refused command, so the target tab never
      // sees a command the controller was already told it could not send.
      const listener = vi.fn();
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener,
      });
      expect(listener).not.toHaveBeenCalled();
    });

    it("tells the controller how long the window has left", () => {
      const { session, now } = buildSession();
      for (let index = 0; index < 4; index += 1) {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        });
      }

      let retryAfterMs: unknown;
      try {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 400,
        });
      } catch (error) {
        retryAfterMs = (error as { retryAfterMs?: number }).retryAfterMs;
      }
      expect(retryAfterMs).toBe(601);
    });

    it("does not let refused commands extend the block", () => {
      const { session, now } = buildSession();
      for (let index = 0; index < 4; index += 1) {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        });
      }
      // Ten rejected retries inside the same window used to each consume a
      // slot, pushing the controller further out than the policy intends.
      for (let index = 0; index < 10; index += 1) {
        expect(() =>
          assertRemoteMouseCommandAdmission({
            sessionId: session.id,
            controllerUserId: "1",
            type: "click",
            now: now + 2,
          })
        ).toThrow();
      }

      expect(() =>
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1002,
        })
      ).not.toThrow();
    });

    it("keeps per-type budgets independent", () => {
      const { session, now } = buildSession();
      for (let index = 0; index < 4; index += 1) {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        });
      }
      expect(() =>
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "pointer-move",
          now: now + 1,
        })
      ).not.toThrow();
    });

    it("charges an admitted command exactly once", () => {
      const { session, now } = buildSession();
      for (let index = 0; index < 4; index += 1) {
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        });
        publishRemoteMouseCommand({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          x: 0.5,
          y: 0.5,
          now: now + 1,
          admitted: true,
        });
      }

      expect(() =>
        assertRemoteMouseCommandAdmission({
          sessionId: session.id,
          controllerUserId: "1",
          type: "click",
          now: now + 1,
        })
      ).toThrowError(expect.objectContaining({ code: "COMMAND_RATE_LIMITED" }));
    });

    it("applies the same admission contract to keyboard commands", () => {
      const { session, now } = buildSession();
      authorizeRemoteKeyboardControl({
        sessionId: session.id,
        controllerUserId: "1",
        passwordConfirmedAt: now,
        now,
      });

      // With no target channel the keyboard command is refused at admission,
      // before any audit or publication work happens.
      expect(() =>
        assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: "1", now: now + 1 })
      ).toThrowError(expect.objectContaining({ code: "TARGET_KEYBOARD_CHANNEL_UNAVAILABLE", statusCode: 409 }));

      subscribeRemoteKeyboardCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener: vi.fn(),
      });
      for (let index = 0; index < 30; index += 1) {
        assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: "1", now: now + 1 });
      }
      expect(() =>
        assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: "1", now: now + 1 })
      ).toThrowError(expect.objectContaining({ code: "KEYBOARD_RATE_LIMITED", statusCode: 429 }));
    });

    it("keeps an admitted keyboard command from paying twice", () => {
      const { session, now } = buildSession();
      authorizeRemoteKeyboardControl({
        sessionId: session.id,
        controllerUserId: "1",
        passwordConfirmedAt: now,
        now,
      });
      subscribeRemoteKeyboardCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-1",
        listener: vi.fn(),
      });

      for (let index = 0; index < 30; index += 1) {
        assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: "1", now: now + 1 });
        publishRemoteKeyboardCommand({
          sessionId: session.id,
          controllerUserId: "1",
          type: "key",
          key: "ArrowDown",
          now: now + 1,
          admitted: true,
        });
      }
      expect(() =>
        assertRemoteKeyboardCommandAdmission({ sessionId: session.id, controllerUserId: "1", now: now + 1 })
      ).toThrowError(expect.objectContaining({ code: "KEYBOARD_RATE_LIMITED" }));
    });
  });

  describe("per-command auditing is off the critical path but still fails closed", () => {
    function auditSession(): RemoteControlSession {
      return buildSession().session;
    }

    it("returns without waiting for the database", async () => {
      const session = auditSession();
      const releases: (() => void)[] = [];
      const writes: unknown[][] = [];
      setRemoteSupportCommandAuditWriterForTests(async (rows) => {
        writes.push(rows);
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      });

      const accepted = enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "click", route: session.targetRoute },
      });

      expect(accepted).toBe(true);
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(1);
      const flush = flushRemoteSupportCommandAudits();
      await Promise.resolve();
      for (const release of releases) release();
      await flush;
      expect(writes).toHaveLength(1);
    });

    it("coalesces a burst into batched inserts rather than one write per command", async () => {
      const session = auditSession();
      const batches: number[] = [];
      setRemoteSupportCommandAuditWriterForTests(async (rows) => {
        batches.push(rows.length);
      });

      for (let index = 0; index < 30; index += 1) {
        enqueueRemoteSupportCommandAudit({
          event: "mouse_command",
          session,
          details: { capability: "mouse", commandType: "pointer-move", route: session.targetRoute },
        });
      }
      await flushRemoteSupportCommandAudits();

      expect(batches.reduce((total, size) => total + size, 0)).toBe(30);
      expect(batches.length).toBeLessThan(30);
      expect(Math.max(...batches)).toBeLessThanOrEqual(25);
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(0);
    });

    it("records the session state in force when the command was authorized", async () => {
      const session = auditSession();
      const rows: Record<string, unknown>[] = [];
      setRemoteSupportCommandAuditWriterForTests(async (batch) => {
        rows.push(...(batch as Record<string, unknown>[]));
      });

      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        actorUserId: "1",
        actorUsername: "developer",
        details: { capability: "mouse", commandType: "click", route: "/reports/sales" },
      });
      await flushRemoteSupportCommandAudits();

      expect(rows[0]).toMatchObject({
        action: "remote_support_mouse_command",
        tableName: "remote_support_sessions",
        companyId: 7,
        recordIdentifier: session.id,
      });
      const changes = rows[0].changes as Record<string, { new: unknown }>;
      expect(changes.targetRoute).toEqual({ new: session.targetRoute });
      expect(changes.route).toEqual({ new: "/reports/sales" });
      expect(changes.controllerUserId).toEqual({ new: "1" });
      expect(JSON.stringify(changes)).not.toContain("password");
    });

    it("stops accepting commands after repeated write failures", async () => {
      const session = auditSession();
      setRemoteSupportCommandAuditWriterForTests(async () => {
        throw new Error("audit database unavailable");
      });

      for (let attempt = 0; attempt < 3; attempt += 1) {
        enqueueRemoteSupportCommandAudit({
          event: "mouse_command",
          session,
          details: { capability: "mouse", commandType: "click", route: session.targetRoute },
        });
        await flushRemoteSupportCommandAudits();
      }

      expect(isRemoteSupportCommandAuditAccepting()).toBe(false);
      expect(getRemoteSupportCommandAuditHealth().consecutiveFailures).toBeGreaterThanOrEqual(3);
      // Control is refused rather than continuing unaudited.
      expect(
        enqueueRemoteSupportCommandAudit({
          event: "mouse_command",
          session,
          details: { capability: "mouse", commandType: "click", route: session.targetRoute },
        })
      ).toBe(false);
    });

    it("recovers and drains the backlog once writes succeed again", async () => {
      const session = auditSession();
      let failing = true;
      const written: unknown[] = [];
      setRemoteSupportCommandAuditWriterForTests(async (rows) => {
        if (failing) throw new Error("audit database unavailable");
        written.push(...rows);
      });

      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "click", route: session.targetRoute },
      });
      await flushRemoteSupportCommandAudits();
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(1);

      failing = false;
      await flushRemoteSupportCommandAudits();

      // The row queued during the outage is not lost.
      expect(written).toHaveLength(1);
      expect(isRemoteSupportCommandAuditAccepting()).toBe(true);
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(0);
    });

    it("drains the queue when a session stops", async () => {
      const { session } = buildSession();
      const written: unknown[] = [];
      setRemoteSupportCommandAuditWriterForTests(async (rows) => {
        written.push(...rows);
      });
      enqueueRemoteSupportCommandAudit({
        event: "mouse_command",
        session,
        details: { capability: "mouse", commandType: "click", route: session.targetRoute },
      });

      installRemoteSupportSessionStopAudit();
      stopRemoteControlSession(session.id, "controller-stopped");
      // The dynamic import and its flush settle across a few microtask turns.
      for (let tick = 0; tick < 10; tick += 1) await Promise.resolve();
      await flushRemoteSupportCommandAudits();

      expect(written).toHaveLength(1);
      expect(getRemoteSupportCommandAuditHealth().pending).toBe(0);
    });

    it("preserves order across a transient failure", async () => {
      const session = auditSession();
      let failOnce = true;
      const actions: string[] = [];
      setRemoteSupportCommandAuditWriterForTests(async (rows) => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transient");
        }
        for (const row of rows as { changes: Record<string, { new: unknown }> }[]) {
          actions.push(String(row.changes.commandType?.new ?? ""));
        }
      });

      for (const commandType of ["pointer-move", "click", "scroll"]) {
        enqueueRemoteSupportCommandAudit({
          event: "mouse_command",
          session,
          details: { capability: "mouse", commandType, route: session.targetRoute },
        });
      }
      await flushRemoteSupportCommandAudits();
      await flushRemoteSupportCommandAudits();

      expect(actions).toEqual(["pointer-move", "click", "scroll"]);
    });
  });
});
