import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeRemoteMouseControl,
  resetRemoteMouseCommandStateForTests,
} from "../server/services/remoteControlCommandService";
import {
  registerRemoteControlTab,
  resetRemoteControlSessionStateForTests,
  startRemoteControlSession,
} from "../server/services/remoteControlSessionService";
import { resetRemoteSupportRolloutForTests, updateRemoteSupportRollout } from "../server/services/remoteSupportRollout";
import { restoreRemoteSupportBootDefaults, updateRemoteSupportFlags } from "../server/services/remoteSupportRuntime";

function registerTargetTab() {
  registerRemoteControlTab({
    userId: "employee-1",
    username: "Employee",
    tabId: "erp-tab-1",
    companyId: 7,
    route: "/dashboard",
  });
}

function startSession() {
  return startRemoteControlSession({
    targetUserId: "employee-1",
    targetUsername: "Employee",
    requestedTabId: "erp-tab-1",
    controllerUserId: "developer-1",
    controllerUsername: "Developer",
    controllerRole: "Developer",
    controllerCompanyId: 7,
  });
}

describe("remote support Phase 8 release boundary", () => {
  beforeEach(() => {
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportRolloutForTests();
    updateRemoteSupportFlags(
      {
        screenFeedEnabled: true,
        fastScreenFeed: true,
        remoteControl: true,
        keyboardControl: true,
        sensitiveActionProtection: true,
      },
      "phase-8-test"
    );
  });

  afterEach(() => {
    resetRemoteMouseCommandStateForTests();
    resetRemoteControlSessionStateForTests();
    resetRemoteSupportRolloutForTests();
    restoreRemoteSupportBootDefaults("phase-8-test-cleanup");
  });

  it("blocks interactive sessions while rollout is disabled", () => {
    registerTargetTab();
    expect(() => startSession()).toThrowError(
      expect.objectContaining({ code: "REMOTE_SUPPORT_ROLLOUT_DISABLED", statusCode: 409 })
    );
  });

  it("preserves the exact ERP-tab scope when rollout is enabled", () => {
    updateRemoteSupportRollout({ stage: "general" }, "developer");
    registerTargetTab();
    const session = startSession();
    expect(session.scope).toBe("erp-browser-tab");
    expect(session.targetTabId).toBe("erp-tab-1");
    expect(session.capabilities.browserTabOnly).toBe(true);
    expect(session.capabilities.mouse).toBe(false);
    expect(session.capabilities.keyboard).toBe(false);
  });

  it("blocks capability activation immediately after rollout is disabled", () => {
    updateRemoteSupportRollout({ stage: "general" }, "developer");
    registerTargetTab();
    const session = startSession();
    updateRemoteSupportRollout({ stage: "disabled" }, "emergency");
    expect(() =>
      authorizeRemoteMouseControl({
        sessionId: session.id,
        controllerUserId: "developer-1",
        passwordConfirmedAt: Date.now(),
      })
    ).toThrowError(expect.objectContaining({ code: "REMOTE_SUPPORT_ROLLOUT_DISABLED" }));
  });
});
