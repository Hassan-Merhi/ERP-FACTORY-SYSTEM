import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _testOnly_resetCompanyCacheScope,
  activateCompanyCacheScope,
  addCompanyMutationHeaders,
  assertCompanyMutationSnapshot,
  assertCompanyReadSnapshot,
  beginCompanyCacheTransition,
  captureCompanyReadSnapshot,
  captureCompanyMutationSnapshot,
  companyReadCacheIdentity,
  isCompanyOwnedApiRead,
  isCompanyOwnedApiMutation,
  rememberVerifiedServerCompanyRevision,
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

  it("stamps only verified company-owned writes with an exact company and revision", () => {
    activateCompanyCacheScope(4);
    expect(() => captureCompanyMutationSnapshot("POST", "/api/vouchers")).toThrow(/Company session changed/);
    rememberVerifiedServerCompanyRevision(4, "server-revision-A");
    const scope = captureCompanyMutationSnapshot("POST", "/api/vouchers");
    expect(scope).toMatchObject({ companyId: 4, serverRevision: "server-revision-A" });
    const headers = new Headers();
    addCompanyMutationHeaders(headers, scope);
    expect(headers.get("X-Expected-Company-Id")).toBe("4");
    expect(headers.get("X-Expected-Company-Revision")).toBe("server-revision-A");

    expect(captureCompanyMutationSnapshot("POST", "/api/auth/set-company")).toBeNull();
    expect(captureCompanyMutationSnapshot("PUT", "/api/user-preferences")).toBeNull();
    expect(isCompanyOwnedApiMutation("POST", "/api/factory/vouchers")).toBe(true);
  });

  it("blocks a prepared draft immediately when another tab changes the company", () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "server-revision-A");
    const oldDraft = captureCompanyMutationSnapshot("POST", "/api/vouchers");
    beginCompanyCacheTransition();
    expect(() => assertCompanyMutationSnapshot(oldDraft)).toThrow();

    activateCompanyCacheScope(5);
    rememberVerifiedServerCompanyRevision(5, "server-revision-B");
    const newDraft = captureCompanyMutationSnapshot("POST", "/api/vouchers");
    expect(newDraft?.serverRevision).toBe("server-revision-B");
    expect(() => assertCompanyMutationSnapshot(oldDraft)).toThrow();
    expect(() => assertCompanyMutationSnapshot(newDraft)).not.toThrow();
  });

  it("invalidates old writes even if the active company ID cycles back to the same value", () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "visit-A");
    const oldDraft = captureCompanyMutationSnapshot("PATCH", "/api/vouchers/12");

    beginCompanyCacheTransition();
    activateCompanyCacheScope(5);
    rememberVerifiedServerCompanyRevision(5, "visit-B");
    beginCompanyCacheTransition();
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "visit-C");

    expect(() => assertCompanyMutationSnapshot(oldDraft)).toThrow();
    expect(captureCompanyMutationSnapshot("PATCH", "/api/vouchers/12")?.serverRevision).toBe("visit-C");
  });

  it("preserves original scope headers when a stale queued operation is retried", () => {
    activateCompanyCacheScope(4);
    rememberVerifiedServerCompanyRevision(4, "visit-A");
    const oldDraft = captureCompanyMutationSnapshot("POST", "/api/vouchers");

    const headers = new Headers({
      "X-Expected-Company-Id": "4",
      "X-Expected-Company-Revision": "visit-A",
    });
    beginCompanyCacheTransition();
    activateCompanyCacheScope(5);
    rememberVerifiedServerCompanyRevision(5, "visit-B");
    addCompanyMutationHeaders(headers, captureCompanyMutationSnapshot("POST", "/api/vouchers"));
    expect(headers.get("X-Expected-Company-Id")).toBe("4");
    expect(headers.get("X-Expected-Company-Revision")).toBe("visit-A");
    expect(() => assertCompanyMutationSnapshot(oldDraft)).toThrow();
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
