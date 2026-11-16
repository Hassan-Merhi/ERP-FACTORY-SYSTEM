import { createElement, type ReactNode } from "react";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isRealtimeReadyMessage,
  refreshRealtimeSessionScope,
  resetWsInvalidationManagerForTests,
  useWsInvalidation,
} from "@/hooks/use-ws-invalidation";
import { QUERY_STALE_TIMES } from "@/lib/queryPolicies";
import { needsLegacyReconnectFallback } from "@/lib/liveQueryRuntimePolicy";

describe("Realtime Refresh Wave 6 final hardening", () => {
  let sockets: FakeSocket[];

  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();

    constructor() {
      sockets.push(this);
    }

    receive(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }

  function wrapper(client: QueryClient) {
    return ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children);
  }

  beforeEach(() => {
    sockets = [];
    resetWsInvalidationManagerForTests();
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  });

  afterEach(() => {
    resetWsInvalidationManagerForTests();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete document.documentElement.dataset.realtimeStatus;
  });

  it("recognizes only the scoped realtime-ready handshake", () => {
    expect(isRealtimeReadyMessage({ type: "realtime:ready" })).toBe(true);
    expect(isRealtimeReadyMessage({ type: "invalidate", topics: ["inventory"] })).toBe(false);
    expect(isRealtimeReadyMessage(null)).toBe(false);
  });

  it("replaces the scoped socket immediately after a company-session switch", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue(undefined);
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    sockets[0].receive({ type: "realtime:ready" });
    expect(document.documentElement.dataset.realtimeStatus).toBe("ready");

    refreshRealtimeSessionScope();

    expect(sockets[0].close).toHaveBeenCalledTimes(1);
    expect(sockets).toHaveLength(2);
    expect(document.documentElement.dataset.realtimeStatus).toBe("connecting");

    // The replaced socket can finish closing later. It is no longer the shared
    // socket and must not schedule a third connection.
    sockets[0].onclose?.();
    expect(sockets).toHaveLength(2);

    sockets[1].onopen?.();
    expect(invalidate).toHaveBeenCalledTimes(1);
    sockets[1].receive({ type: "realtime:ready" });
    expect(document.documentElement.dataset.realtimeStatus).toBe("ready");
  });

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
