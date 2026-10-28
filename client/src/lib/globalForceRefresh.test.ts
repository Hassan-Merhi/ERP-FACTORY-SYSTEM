import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  sessionStorage.clear();
  vi.resetModules();
});

describe("global force refresh token", () => {
  it("seeds a new tab without refreshing, then refreshes for each new server token once", async () => {
    const { shouldApplyGlobalForceRefresh } = await import("./globalForceRefresh");

    expect(shouldApplyGlobalForceRefresh("")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("new-epoch-1")).toBe(true);
    expect(sessionStorage.getItem("erp:global-force-refresh-token")).toBe("new-epoch-1");
    expect(shouldApplyGlobalForceRefresh("new-epoch-1")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("new-epoch-2")).toBe(true);
  });

  it("does not force a new session to reload when already on the latest version", async () => {
    const { shouldApplyGlobalForceRefresh } = await import("./globalForceRefresh");
    expect(shouldApplyGlobalForceRefresh("already-issued")).toBe(false);
    expect(shouldApplyGlobalForceRefresh("already-issued")).toBe(false);
  });
});
