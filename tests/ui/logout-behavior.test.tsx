/**
 * Signing out (useAuthenticatedUser.handleLogout).
 *
 * The biometric credential wipe runs against the real Capacitor Preferences
 * plugin here, because a stand-in hides the failure this guards against: an
 * await on the plugin that never settles, which left sign-out stuck before the
 * redirect to the login page.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  cancelQueries: vi.fn(),
  clear: vi.fn(),
  resetCsrfToken: vi.fn(),
  wipeColdStartAccess: vi.fn(),
  revokeOfflineReadScope: vi.fn(),
  clearChristmas: vi.fn(),
  replace: vi.fn(),
  order: [] as string[],
}));

vi.mock("@/lib/queryClient", () => ({
  apiRequest: harness.apiRequest,
  queryClient: { cancelQueries: harness.cancelQueries, clear: harness.clear },
  resetCsrfToken: harness.resetCsrfToken,
}));

vi.mock("@/contracts/sessionQueryContracts", () => ({
  authenticatedUserQueryOptions: () => ({
    queryKey: ["/api/auth/me"],
    queryFn: async () => ({ id: 42, username: "operator", role: "Admin" }),
  }),
}));

vi.mock("@/lib/offline/offlineReadCache", () => ({
  wipeColdStartAccess: harness.wipeColdStartAccess,
  revokeOfflineReadScope: harness.revokeOfflineReadScope,
}));

vi.mock("@/lib/christmasLoginEntrance", () => ({
  clearChristmasLoginEntrancePending: harness.clearChristmas,
}));

import { useAuthenticatedUser } from "@/app/useAuthenticatedUser";

const CREDS_STORAGE_KEY = "CapacitorStorage.biometric_creds";
const originalLocation = window.location;

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function signedInHook() {
  const hook = renderHook(() => useAuthenticatedUser(), { wrapper });
  await waitFor(() => expect(hook.result.current.user).toEqual(expect.objectContaining({ id: 42 })));
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.order.length = 0;
  localStorage.clear();
  harness.cancelQueries.mockImplementation(async () => void harness.order.push("cancelQueries"));
  harness.apiRequest.mockImplementation(async (method: string, url: string) => {
    harness.order.push(`${method} ${url}`);
    return { ok: true, json: async () => ({}) };
  });
  harness.clear.mockImplementation(() => void harness.order.push("clear"));
  harness.resetCsrfToken.mockImplementation(() => void harness.order.push("resetCsrfToken"));
  harness.replace.mockImplementation((url: string) => void harness.order.push(`replace ${url}`));
  harness.wipeColdStartAccess.mockResolvedValue(undefined);
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, pathname: "/", replace: harness.replace },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation });
  vi.restoreAllMocks();
});

describe("signing out", () => {
  it("ends the server session, wipes local state and saved credentials, then returns to the login page", async () => {
    localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify({ username: "operator", password: "s3cret" }));
    const { result } = await signedInHook();

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(harness.order).toEqual([
      "cancelQueries",
      "POST /api/auth/logout",
      "clear",
      "resetCsrfToken",
      "replace /login",
    ]);
    expect(localStorage.getItem(CREDS_STORAGE_KEY)).toBeNull();
    expect(harness.wipeColdStartAccess).toHaveBeenCalledWith("42");
    expect(harness.revokeOfflineReadScope).toHaveBeenCalledTimes(1);
    expect(harness.clearChristmas).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("erp_offline_logout_broadcast")).toMatch(/^\d+$/);
  });

  it("keeps local state and stays on the page when the server refuses to end the session", async () => {
    localStorage.setItem(CREDS_STORAGE_KEY, JSON.stringify({ username: "operator", password: "s3cret" }));
    harness.apiRequest.mockRejectedValue(new Error("503: Service Unavailable"));
    const { result } = await signedInHook();

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.clear).not.toHaveBeenCalled();
    expect(harness.resetCsrfToken).not.toHaveBeenCalled();
    expect(localStorage.getItem(CREDS_STORAGE_KEY)).not.toBeNull();
    // The offline read scope is revoked up front, whatever the server answers.
    expect(harness.revokeOfflineReadScope).toHaveBeenCalledTimes(1);
  });

  it("still signs out when the browser refuses localStorage writes", async () => {
    const { result } = await signedInHook();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });

    await act(async () => {
      await result.current.handleLogout();
    });

    expect(harness.replace).toHaveBeenCalledWith("/login");
  });
});
