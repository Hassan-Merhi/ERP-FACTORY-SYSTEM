// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  QUERY_GC_TIMES,
  QUERY_STALE_TIMES,
  accessQueryPolicy,
  liveCountQueryPolicy,
  stableReferenceQueryPolicy,
  stableSettingsQueryPolicy,
  visibleTabInterval,
} from "../../client/src/lib/queryPolicies";

describe("Group A Phase 2 query policies", () => {
  it("keeps settings and reference data cached without passive refetches", () => {
    expect(stableSettingsQueryPolicy.staleTime).toBe(QUERY_STALE_TIMES.settings);
    expect(stableReferenceQueryPolicy.staleTime).toBe(QUERY_STALE_TIMES.referenceData);
    expect(stableReferenceQueryPolicy.gcTime).toBe(QUERY_GC_TIMES.referenceData);
    expect(stableSettingsQueryPolicy.refetchOnMount).toBe(false);
    expect(stableSettingsQueryPolicy.refetchOnWindowFocus).toBe(false);
    expect(stableReferenceQueryPolicy.refetchOnReconnect).toBe(false);
  });

  it("caches access metadata while preserving explicit invalidation", () => {
    expect(accessQueryPolicy.staleTime).toBe(5 * 60_000);
    expect(accessQueryPolicy.refetchOnMount).toBe(false);
    expect(accessQueryPolicy.refetchOnWindowFocus).toBe(false);
  });

  it("pauses live polling while the browser tab is hidden", () => {
    const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    expect(visibleTabInterval(60_000)()).toBe(false);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    expect(visibleTabInterval(60_000)()).toBe(60_000);
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
  });

  it("never enables live polling in background tabs", () => {
    const policy = liveCountQueryPolicy(60_000);
    expect(policy.staleTime).toBe(QUERY_STALE_TIMES.liveCount);
    expect(policy.refetchIntervalInBackground).toBe(false);
    expect(policy.refetchOnWindowFocus).toBe(false);
    expect(policy.refetchOnReconnect).toBe(true);
    expect(policy.refetchInterval).toBeTypeOf("function");
  });
});
