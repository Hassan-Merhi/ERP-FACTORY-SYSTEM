import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe("global force refresh token", () => {
  it("announces five seconds before refreshing, without rounding below zero", async () => {
    const { FORCE_REFRESH_COUNTDOWN_MS, secondsUntilForceRefresh } = await import("./globalForceRefresh");
    expect(FORCE_REFRESH_COUNTDOWN_MS).toBe(5_000);
    const deadline = 15_000;
    expect(secondsUntilForceRefresh(deadline, 10_000)).toBe(5);
    expect(secondsUntilForceRefresh(deadline, 11_001)).toBe(4);
    expect(secondsUntilForceRefresh(deadline, 14_001)).toBe(1);
    expect(secondsUntilForceRefresh(deadline, 15_000)).toBe(0);
    expect(secondsUntilForceRefresh(deadline, 17_000)).toBe(0);
  });

  it("seeds a new tab without refreshing, then refreshes for each new server token once", async () => {
    const { shouldApplyGlobalForceRefresh } = await import("./globalForceRefresh");

    expect(shouldApplyGlobalForceRefresh("")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("new-epoch-1")).toBe(true);
    expect(sessionStorage.getItem("erp:global-force-refresh-token:regular")).toBe("new-epoch-1");
    expect(shouldApplyGlobalForceRefresh("new-epoch-1")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("new-epoch-2")).toBe(true);
  });

  it("ignores an old token in Safari sessionStorage when signing in", async () => {
    sessionStorage.setItem("erp:global-force-refresh-token", "old-login-token");
    sessionStorage.setItem("erp:global-force-refresh-token:privileged", "old-admin-token");
    const { shouldApplyGlobalForceRefresh } = await import("./globalForceRefresh");
    expect(shouldApplyGlobalForceRefresh("current-admin-token", "privileged")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("current-admin-token", "privileged")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("clicked-settings-button", "privileged")).toBe(true);
  });

  it("starts a new baseline on login, logout, or a different refresh audience", async () => {
    const { shouldApplyGlobalForceRefresh, resetGlobalForceRefreshBaseline } = await import("./globalForceRefresh");
    expect(shouldApplyGlobalForceRefresh("regular-1", "regular")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("admin-1", "privileged")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("admin-2", "privileged")).toBe(true);
    resetGlobalForceRefreshBaseline();
    expect(shouldApplyGlobalForceRefresh("admin-2", "privileged")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("admin-3", "privileged")).toBe(true);
  });
});
