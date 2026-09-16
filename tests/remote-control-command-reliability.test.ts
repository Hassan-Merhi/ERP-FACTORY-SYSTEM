import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorizeRemoteMouseControl,
  cleanupRemoteMouseCommandState,
  publishRemoteMouseCommand,
  publishRemoteMouseCommandResult,
  resetRemoteMouseCommandStateForTests,
  subscribeRemoteMouseCommands,
  subscribeRemoteMouseResults,
} from "../server/services/remoteControlCommandService";
import {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
  startRemoteControlSession,
} from "../server/services/remoteControlSessionService";
import { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } from "../server/services/remoteSupportRollout";
import { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";

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
    now,
  });
  authorizeRemoteMouseControl({
    sessionId: session.id,
    controllerUserId: "1",
    passwordConfirmedAt: now,
    now,
  });
  return { session, now };
}

describe("remote mouse command reliability", () => {
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
      "phase-6-test"
    );
    updateRemoteSupportRollout({ stage: "general" }, "phase-6-test");
  });

  afterEach(() => {
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportRolloutForTests();
    restoreRemoteSupportBootDefaults("phase-6-test-cleanup");
  });

  it("queues commands while the target stream is disconnected", () => {
    const { session, now } = buildSession();

    const command = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 1,
    }).command;

    expect(command.sequence).toBe(1);
  });

  it("replays pending commands in sequence order after reconnect", () => {
    const { session, now } = buildSession();
    const first = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "pointer-move",
      x: 0.25,
      y: 0.25,
      now: now + 1,
    }).command;
    const second = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 2,
    }).command;
    const third = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "scroll",
      x: 0.5,
      y: 0.5,
      deltaX: 0,
      deltaY: 120,
      now: now + 3,
    }).command;

    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });

    expect(listener.mock.calls.map(([command]) => command.id)).toEqual([first.id, second.id, third.id]);
    expect(listener.mock.calls.map(([command]) => command.sequence)).toEqual([1, 2, 3]);
  });

  it("replays only commands that have not been acknowledged", () => {
    const { session, now } = buildSession();
    const first = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.4,
      y: 0.4,
      now: now + 1,
    }).command;
    const second = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.6,
      y: 0.6,
      now: now + 2,
    }).command;

    publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: first.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      status: "executed",
      now: now + 3,
    });

    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(second);
  });

  it("treats duplicate acknowledgements as idempotent", () => {
    const { session, now } = buildSession();
    const command = publishRemoteMouseCommand({
      sessionId: session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: now + 1,
    }).command;

    const first = publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: command.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      status: "executed",
      now: now + 2,
    });
    const duplicate = publishRemoteMouseCommandResult({
      sessionId: session.id,
      commandId: command.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      status: "executed",
      now: now + 3,
    });

    expect(duplicate).toEqual(first);
  });

  it("publishes an ignored timeout result for unacknowledged commands", () => {
    const { session, now } = buildSession();
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

    cleanupRemoteMouseCommandState(now + 15_002);

    expect(resultListener).toHaveBeenCalledWith({
      commandId: command.id,
      sessionId: session.id,
      status: "ignored",
      reason: "command-timeout",
      completedAt: now + 15_002,
    });
  });

  it("does not replay commands into another session", () => {
    const first = buildSession("22", "erp-tab-1");
    const second = buildSession("23", "erp-tab-2");
    const firstCommand = publishRemoteMouseCommand({
      sessionId: first.session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: first.now + 1,
    }).command;
    publishRemoteMouseCommand({
      sessionId: second.session.id,
      controllerUserId: "1",
      type: "click",
      x: 0.5,
      y: 0.5,
      now: second.now + 1,
    });

    const listener = vi.fn();
    subscribeRemoteMouseCommands({
      sessionId: first.session.id,
      targetUserId: "22",
      targetTabId: "erp-tab-1",
      listener,
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(firstCommand);
  });
});
