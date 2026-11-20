import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly_resetCompanyCacheScope,
  activateCompanyCacheScope,
  assertCompanyReadSnapshot,
  beginCompanyCacheTransition,
  captureCompanyReadSnapshot,
  companyReadCacheIdentity,
  isCompanyOwnedApiRead,
  resumeCompanyCacheScope,
} from "../../client/src/lib/companyCacheScope";
import { registerBandwidthCacheInvalidator } from "../../client/src/lib/bandwidthInvalidationPolicy";
import { buildRequestKey } from "../../client/src/lib/requestStormGuardAcquireGetSlot";
import { fetchQueryCacheKey } from "../../client/src/lib/fetchRequestUtils";

beforeEach(() => _testOnly_resetCompanyCacheScope());
afterEach(() => _testOnly_resetCompanyCacheScope());

describe("company-scoped browser cache identity", () => {
  it("adopts the initial authenticated company without aborting startup reads", () => {
    const startupRead = captureCompanyReadSnapshot();
    activateCompanyCacheScope(1);
    expect(() => assertCompanyReadSnapshot(startupRead)).not.toThrow();
    expect(companyReadCacheIdentity()).toContain("1:0:verified");
  });

  it("rejects old and in-flight results as soon as a switch starts", () => {
    activateCompanyCacheScope(1);
    const oldRead = captureCompanyReadSnapshot();
    beginCompanyCacheTransition();
    expect(() => assertCompanyReadSnapshot(oldRead)).toThrow(/Company session changed/);
    expect(() => assertCompanyReadSnapshot(captureCompanyReadSnapshot())).toThrow(/Company session changed/);

    activateCompanyCacheScope(2);
    const newRead = captureCompanyReadSnapshot();
    expect(() => assertCompanyReadSnapshot(newRead)).not.toThrow();
    expect(() => assertCompanyReadSnapshot(oldRead)).toThrow();
    expect(newRead.companyId).toBe(2);
    expect(newRead.revision).toBeGreaterThan(oldRead.revision);
  });

  it("fences a refused switch without replacing the selected company", () => {
    activateCompanyCacheScope(3);
    const oldRead = captureCompanyReadSnapshot();
    const before = companyReadCacheIdentity();
    beginCompanyCacheTransition();
    resumeCompanyCacheScope();

    expect(captureCompanyReadSnapshot().companyId).toBe(3);
    expect(companyReadCacheIdentity()).not.toBe(before);
    expect(() => assertCompanyReadSnapshot(oldRead)).toThrow();
    expect(() => assertCompanyReadSnapshot(captureCompanyReadSnapshot())).not.toThrow();
  });

  it("invalidates both bandwidth cache guards on start, commit and resume", () => {
    const invalidate = vi.fn();
    const unregister = registerBandwidthCacheInvalidator(invalidate);
    try {
      activateCompanyCacheScope(1);
      beginCompanyCacheTransition();
      beginCompanyCacheTransition(); // nested signals must not churn generations
      activateCompanyCacheScope(2);
      beginCompanyCacheTransition();
      resumeCompanyCacheScope();
      expect(invalidate).toHaveBeenCalledTimes(4);
      expect(invalidate.mock.calls.every(([scope]) => scope === "all")).toBe(true);
    } finally {
      unregister();
    }
  });

  it("isolates URL-only bandwidth snapshots and pagination under every session revision", () => {
    const url = new URL("https://example.test/api/customers?active=1");
    const headers = new Headers({ Accept: "application/json" });
    activateCompanyCacheScope(1);
    const stormA = buildRequestKey(url, headers);
    const pageA = fetchQueryCacheKey(url, ["page"]);

    beginCompanyCacheTransition();
    activateCompanyCacheScope(2);
    const stormB = buildRequestKey(url, headers);
    const pageB = fetchQueryCacheKey(url, ["page"]);
    expect(stormB).not.toBe(stormA);
    expect(pageB).not.toBe(pageA);

    beginCompanyCacheTransition();
    resumeCompanyCacheScope();
    expect(buildRequestKey(url, headers)).not.toBe(stormB);
    expect(fetchQueryCacheKey(url, ["page"])).not.toBe(pageB);
  });

  it("allows auth/session probes during a switch but blocks company-owned business reads", () => {
    for (const path of [
      "/api/auth/me",
      "/api/auth/session-company",
      "/api/user/companies",
      "/api/csrf-token",
      "/api/health/ready",
      "/api/build-info",
      "/api/boot",
    ]) {
      expect(isCompanyOwnedApiRead(path)).toBe(false);
    }
    expect(isCompanyOwnedApiRead("/api/customers")).toBe(true);
    expect(isCompanyOwnedApiRead("/api/factory/daybook")).toBe(true);
    expect(isCompanyOwnedApiRead("/api/accounts/4/transactions")).toBe(true);
  });
});
