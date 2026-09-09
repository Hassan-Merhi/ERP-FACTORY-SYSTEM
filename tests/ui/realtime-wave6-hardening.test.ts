import { describe, expect, it } from "vitest";
import { QUERY_STALE_TIMES } from "@/lib/queryPolicies";
import { needsLegacyReconnectFallback } from "@/lib/liveQueryRuntimePolicy";

describe("Realtime Refresh Wave 6 final hardening", () => {
  it("lets TanStack own reconnects for normal live queries", () => {
    expect(
      needsLegacyReconnectFallback(["/api/inventory", 7], {
        staleTime: QUERY_STALE_TIMES.live,
        refetchOnReconnect: () => true,
      })
    ).toBe(false);
  });

  it("keeps a reconnect fallback only for legacy live-query overrides", () => {
    expect(
      needsLegacyReconnectFallback(["/api/inventory", 7], {
        staleTime: QUERY_STALE_TIMES.live,
        refetchOnReconnect: false,
      })
    ).toBe(true);

    expect(
      needsLegacyReconnectFallback(["/api/inventory", 7], {
        staleTime: 10 * 60_000,
        refetchOnReconnect: () => true,
      })
    ).toBe(true);
  });

  it("never applies the reconnect fallback to stable reference data", () => {
    expect(
      needsLegacyReconnectFallback(["/api/stock-items/light", 7], {
        staleTime: 30 * 60_000,
        refetchOnReconnect: false,
      })
    ).toBe(false);
  });
});
