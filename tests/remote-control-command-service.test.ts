import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeRemoteMouseControl,
  getRemoteMouseAuthorization,
  publishRemoteMouseCommand,
  publishRemoteMouseCommandResult,
  resetRemoteMouseCommandStateForTests,
  revokeRemoteMouseControl,
  sanitizeRemoteMouseFrameViewport,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
} from "../server/services/remoteControlCommandService";
import {
  getRemoteControlSession,
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
  startRemoteControlSession,
} from "../server/services/remoteControlSessionService";
import { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";
import { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } from "../server/services/remoteSupportRollout";

function buildSession() {
  const now = Date.now();
  registerRemoteControlTab({
    userId: "22",
    username: "employee",
    tabId: "erp-tab-1",
    companyId: 7,
    route: "/dashboard",
    now,
  });
  return startRemoteControlSession({
    targetUserId: "22",
    targetUsername: "employee",
    controllerUserId: "1",
    controllerUsername: "developer",
    controllerRole: "Developer",
    controllerCompanyId: 7,
    durationMs: 10 * 60 * 1000,
  });
}

describe("remote mouse command safety", () => {
  beforeEach(() => {
    resetRemoteSupportRolloutForTests();
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    updateRemoteSupportFlags(
      {
        screenFeedEnabled: true,
        fastScreenFeed: true,
        remoteControl: true,
        keyboardControl: false,
        sensitiveActionProtection: true,
      },
      "phase-5-test"
    );
    updateRemoteSupportRollout({ stage: "general" }, "remote-support-test");
  });

  afterEach(() => {
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportRolloutForTests();
    restoreRemoteSupportBootDefaults("phase-5-test-cleanup");
  });

  it("keeps passive viewing read-only before mouse authorization", () => {
    const session = buildSession();
    expect(session.capabilities.mouse).toBe(false);
    expect(getRemoteControlSession(session.id)?.capabilities.mouse).toBe(false);
  });

  it("requires a recent password confirmation before mouse authorization", () => {
    const session = buildSession();
    expect(() =>
      authorizeRemoteMouseControl({
        sessionId: session.id,
        controllerUserId: "1",
        passwordConfirmedAt: null,
      })
    ).toThrowError(expect.objectContaining({ code: "PASSWORD_CONFIRMATION_REQUIRED", statusCode: 428 }));
    expect(getRemoteControlSession(session.id)?.capabilities.mouse).toBe(false);
  });

  it("authorizes the owning controller for at most five minutes", () => {
    const session = buildSession();
    const now = Date.now();
    const authorization = authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });

    expect(authorization.expiresAt).toBe(now + 5 * 60 * 1000);
    expect(getRemoteControlSession(session.id)?.capabilities.mouse).toBe(true);
    expect(getRemoteMouseAuthorization(session.id, "1", now + 1000)?.sessionId).toBe(session.id);
    expect(getRemoteMouseAuthorization(session.id, "1", authorization.expiresAt + 1)).toBeNull();
    expect(getRemoteControlSession(session.id)?.capabilities.mouse).toBe(false);
  });

  it("revokes mouse capability without ending passive viewing", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });

    revokeRemoteMouseControl({ sessionId: session.id, controllerUserId: "1" });

    expect(getRemoteMouseAuthorization(session.id, "1", now + 1)).toBeNull();
    expect(getRemoteControlSession(session.id)?.status).toBe("active");
    expect(getRemoteControlSession(session.id)?.capabilities.mouse).toBe(false);
    expect(() =>
      publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "click",
        x: 0.5,
        y: 0.5,
        now: now + 1,
      })
    ).toThrowError(expect.objectContaining({ code: "MOUSE_CONTROL_DISABLED", statusCode: 409 }));
  });

  it("rejects a controller that does not own the session", () => {
    const session = buildSession();
    expect(() =>
      authorizeRemoteMouseControl({
        sessionId: session.id,
        controllerUserId: "2",
        passwordConfirmedAt: Date.now(),
      })
    ).toThrowError(expect.objectContaining({ code: "CONTROLLER_MISMATCH", statusCode: 403 }));
  });

  it("delivers normalized pointer, click, and bounded scroll commands to the exact target tab", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });
    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });

    const pointer = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "pointer-move",
      x: 0.25,
      y: 0.75,
      now: now + 1,
    }).command;
    const click = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 2,
    }).command;
    const scroll = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "scroll",
      x: 0.5,
      y: 0.5,
      deltaX: 5000,
      deltaY: -5000,
      now: now + 3,
    }).command;

    expect(pointer.sequence).toBe(1);
    expect(click.sequence).toBe(2);
    expect(scroll.sequence).toBe(3);
    expect(scroll.deltaX).toBe(1200);
    expect(scroll.deltaY).toBe(-1200);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("fails closed for invalid coordinates and empty scrolls while queueing a temporarily offline target", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });

    expect(() =>
      publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "click",
        x: 2,
        y: 0.5,
        now: now + 1,
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_COORDINATES", statusCode: 400 }));

    expect(() =>
      publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "scroll",
        x: 0.5,
        y: 0.5,
        deltaX: 0,
        deltaY: 0,
        now: now + 2,
      })
    ).toThrowError(expect.objectContaining({ code: "INVALID_SCROLL", statusCode: 400 }));

    const queued = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 3,
    }).command;
    expect(queued.sequence).toBe(1);
  });

  it("carries the captured frame viewport to the target and drops malformed snapshots", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });
    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });

    const frameViewport = { width: 1280, height: 720, scrollX: 0, scrollY: 240, visualScale: 1 };
    const click = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      frameViewport,
      now: now + 1,
    });
    expect(click.frameViewport).toEqual(frameViewport);
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ frameViewport }));

    // A malformed snapshot must never block an otherwise valid command: the
    // target falls back to the live-viewport mapping for legacy controllers.
    const legacy = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      frameViewport: { width: "wide", scrollY: -50 },
      now: now + 2,
    });
    expect(legacy.frameViewport).toBeUndefined();

    const absent = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "scroll",
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: 120,
      now: now + 3,
    });
    expect(absent.frameViewport).toBeUndefined();

    expect(sanitizeRemoteMouseFrameViewport(null)).toBeUndefined();
    expect(
      sanitizeRemoteMouseFrameViewport({ width: 0, height: 720, scrollX: 0, scrollY: 0, visualScale: 1 })
    ).toBeUndefined();
    expect(
      sanitizeRemoteMouseFrameViewport({ width: 1280, height: 720, scrollX: 0, scrollY: 0, visualScale: 99 })
    ).toBeUndefined();
  });

  it("rejects command subscriptions from a different user or browser tab", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });

    expect(() =>
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "23",
        targetTabId: "erp-tab-1",
        listener: vi.fn(),
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH", statusCode: 403 }));
    expect(() =>
      subscribeRemoteMouseCommands({
        sessionId: session.id,
        targetUserId: "22",
        targetTabId: "erp-tab-2",
        listener: vi.fn(),
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH", statusCode: 403 }));
  });

  it("rate limits command floods per session and command type", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener: vi.fn(),
    });

    for (let index = 0; index < 20; index += 1) {
      publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "pointer-move",
        x: 0.5,
        y: 0.5,
        now,
      });
    }
    expect(() =>
      publishRemoteMouseCommand({
        sessionId: session.id,
        controllerUserId: "1",
        type: "pointer-move",
        x: 0.5,
        y: 0.5,
        now,
      })
    ).toThrowError(expect.objectContaining({ code: "COMMAND_RATE_LIMITED", statusCode: 429 }));
  });

  it("accepts results only from the bound target and pushes them to the owning controller", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener: vi.fn(),
    });
    const resultListener = vi.fn();
    subscribeRemoteMouseResults({
      sessionId: session.id,
      controllerUserId: "1",
      listener: resultListener,
    });
    const command = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 1,
    }).command;

    expect(() =>
      publishRemoteMouseCommandResult({
        sessionId: session.id,
        commandId: command.id,
        targetUserId: "23",
        targetTabId: "erp-tab-1",
        status: "executed",
      })
    ).toThrowError(expect.objectContaining({ code: "TARGET_MISMATCH", statusCode: 403 }));

    const result = publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: command.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      status: "blocked",
      reason: "protected-element",
      now: now + 2,
    });
    expect(result.status).toBe("blocked");
    expect(result.reason).toBe("protected-element");
    expect(resultListener).toHaveBeenCalledWith(result);
  });

  it("isolates broken command and result listeners", () => {
    const session = buildSession();
    const now = Date.now();
    authorizeRemoteMouseControl({
      sessionId: session.id,
      controllerUserId: "1",
      passwordConfirmedAt: now,
      now,
    });
    const healthyCommandListener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener: () => {
        throw new Error("closed stream");
      },
    });
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener: healthyCommandListener,
    });
    const healthyResultListener = vi.fn();
    subscribeRemoteMouseResults({
      sessionId: session.id,
      controllerUserId: "1",
      listener: () => {
        throw new Error("closed stream");
      },
    });
    subscribeRemoteMouseResults({
      sessionId: session.id,
      controllerUserId: "1",
      listener: healthyResultListener,
    });

    const command = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 1,
    }).command;
    const result = publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: command.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      status: "executed",
      now: now + 2,
    });

    expect(healthyCommandListener).toHaveBeenCalledWith(command);
    expect(healthyResultListener).toHaveBeenCalledWith(result);
  });
});
