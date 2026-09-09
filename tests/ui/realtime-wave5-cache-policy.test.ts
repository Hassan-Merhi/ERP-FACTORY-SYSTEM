import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY_STALE_TIME,
  isLiveTransactionalQueryKey,
  QUERY_STALE_TIMES,
  staleTimeForQueryKey,
} from "@/lib/queryPolicies";
import { shouldRefreshLiveQueryOnObserverAdd } from "@/lib/liveQueryRuntimePolicy";

describe("Realtime Refresh Wave 5 cache policy", () => {
  it("keeps exact reference endpoints long-lived while their transactional descendants are live", () => {
    expect(staleTimeForQueryKey(["/api/locations?includeInactive=true", 7])).toBe(
      QUERY_STALE_TIMES.referenceData
    );
    expect(isLiveTransactionalQueryKey(["/api/locations", 7])).toBe(false);

    expect(isLiveTransactionalQueryKey(["/api/locations/7/inventory?includeZero=true"])).toBe(true);
    expect(staleTimeForQueryKey(["/api/locations/7/inventory?includeZero=true"])).toBe(QUERY_STALE_TIMES.live);
  });

  it("classifies the core ERP and Factory transactional families as live", () => {
    for (const key of [
      "/api/inventory?page=1&pageSize=100",
      "/api/pos/sales",
      "/api/vouchers/42",
      "/api/stock-transfers?voucherId=91",
      "/api/containers/77",
      "/api/factory/daily-bale-scans?date=2026-09-09",
      "/api/factory/payrolls/preview",
      "/api/factory/customer-orders/55",
    ]) {
      expect(isLiveTransactionalQueryKey([key]), key).toBe(true);
      expect(staleTimeForQueryKey([key]), key).toBe(QUERY_STALE_TIMES.live);
    }
  });

  it("does not shorten unrelated or stable configuration data", () => {
    expect(staleTimeForQueryKey(["/api/company-settings"])).toBe(QUERY_STALE_TIMES.settings);
    expect(staleTimeForQueryKey(["/api/factory/workers?active=true"])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/new-unclassified-module"])).toBe(DEFAULT_QUERY_STALE_TIME);
  });

  it("refreshes an old live snapshot on remount even if a page declared a longer local staleTime", () => {
    const now = 100_000;
    expect(
      shouldRefreshLiveQueryOnObserverAdd(
        ["/api/inventory", 7],
        { dataUpdatedAt: now - QUERY_STALE_TIMES.live - 1, fetchStatus: "idle", isInvalidated: false },
        now
      )
    ).toBe(true);

    expect(
      shouldRefreshLiveQueryOnObserverAdd(
        ["/api/inventory", 7],
        { dataUpdatedAt: now - 1_000, fetchStatus: "idle", isInvalidated: false },
        now
      )
    ).toBe(false);
  });

  it("never duplicates an in-flight fetch and leaves reference queries alone", () => {
    expect(
      shouldRefreshLiveQueryOnObserverAdd(
        ["/api/vouchers/3"],
        { dataUpdatedAt: 1, fetchStatus: "fetching", isInvalidated: true },
        100_000
      )
    ).toBe(false);
    expect(
      shouldRefreshLiveQueryOnObserverAdd(
        ["/api/stock-items/light", 7],
        { dataUpdatedAt: 1, fetchStatus: "idle", isInvalidated: true },
        100_000
      )
    ).toBe(false);
  });
});
