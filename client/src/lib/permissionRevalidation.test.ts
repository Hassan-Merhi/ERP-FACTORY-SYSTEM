import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  PERMISSION_REVALIDATE_STORAGE_KEY,
  _testOnly_resetPermissionRevalidation,
  installPermissionRevalidationListener,
  isAccessQueryKey,
  isPermissionDenial,
  requestPermissionRevalidation,
} from "./permissionRevalidation";

describe("permission revalidation", () => {
  beforeEach(() => {
    _testOnly_resetPermissionRevalidation();
    window.localStorage.clear();
  });
  afterEach(() => vi.restoreAllMocks());

  it("recognises role and permission refusals only", () => {
    expect(isPermissionDenial(403, "BUSINESS_ACTION_NOT_VERIFIED")).toBe(true);
    expect(isPermissionDenial(403, "FACTORY_PAGE_ACCESS_DENIED")).toBe(true);
    expect(isPermissionDenial(403, undefined, "View Only accounts cannot make changes")).toBe(true);
    expect(isPermissionDenial(403, "CSRF_TOKEN_MISMATCH")).toBe(false);
    expect(isPermissionDenial(409, "BUSINESS_ACTION_NOT_VERIFIED")).toBe(false);
    expect(isPermissionDenial(403, "PERIOD_CLOSED", "Accounting period is closed")).toBe(false);
  });

  it("classifies access query keys", () => {
    expect(isAccessQueryKey(["/api/auth/me"])).toBe(true);
    expect(isAccessQueryKey(["/api/my-permissions", 7])).toBe(true);
    expect(isAccessQueryKey(["/api/factory/my-access"])).toBe(true);
    expect(isAccessQueryKey(["/api/vouchers"])).toBe(false);
    expect(isAccessQueryKey([42])).toBe(false);
  });

  it("refetches access queries, signals other tabs and throttles bursts", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    expect(requestPermissionRevalidation(client, 10_000)).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(window.localStorage.getItem(PERMISSION_REVALIDATE_STORAGE_KEY)).toBe("10000");
    expect(requestPermissionRevalidation(client, 11_000)).toBe(false);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(requestPermissionRevalidation(client, 14_000)).toBe(true);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });

  it("follows revalidation requests from another tab", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    const stop = installPermissionRevalidationListener(client);
    window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: "3" }));
    expect(invalidate).not.toHaveBeenCalled();
    window.dispatchEvent(new StorageEvent("storage", { key: PERMISSION_REVALIDATE_STORAGE_KEY, newValue: "123" }));
    expect(invalidate).toHaveBeenCalledTimes(1);
    stop();
    window.dispatchEvent(new StorageEvent("storage", { key: PERMISSION_REVALIDATE_STORAGE_KEY, newValue: "456" }));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
