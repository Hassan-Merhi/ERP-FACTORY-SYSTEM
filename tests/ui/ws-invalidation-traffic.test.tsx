import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { resetWsInvalidationManagerForTests, useWsInvalidation } from "@/hooks/use-ws-invalidation";

/**
 * Every write in the system broadcasts, and every broadcast makes each
 * receiving client refetch what it has on screen. Two things kept that bill
 * higher than it needed to be: a burst of writes produced a round of
 * refetching every 800ms, and hidden tabs — of which people keep several —
 * refetched exactly like the one being looked at.
 */
describe("WebSocket invalidation traffic", () => {
  let sockets: FakeSocket[];
  let visibility: DocumentVisibilityState;

  class FakeSocket {
    onopen: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    close = vi.fn();

    constructor() {
      sockets.push(this);
    }

    receiveInvalidate() {
      this.onmessage?.({ data: JSON.stringify({ type: "invalidate" }) });
    }
  }

  function setVisibility(next: DocumentVisibilityState) {
    visibility = next;
    document.dispatchEvent(new Event("visibilitychange"));
  }

  function wrapper(client: QueryClient) {
    return ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
  }

  function queryWithKey(key: string): Query {
    return { queryKey: [key] } as unknown as Query;
  }

  beforeEach(() => {
    sockets = [];
    visibility = "visible";
    resetWsInvalidationManagerForTests();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  });

  afterEach(() => {
    resetWsInvalidationManagerForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("coalesces a burst of writes into one refresh", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    for (let i = 0; i < 10; i += 1) {
      sockets[0].receiveInvalidate();
      vi.advanceTimersByTime(200);
    }
    expect(invalidate).not.toHaveBeenCalled();

    // Still quiet a second after the burst: the window is wider than it was.
    vi.advanceTimersByTime(1_000);
    expect(invalidate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2_000);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("does not refetch a tab nobody is looking at", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    setVisibility("hidden");
    sockets[0].receiveInvalidate();
    vi.advanceTimersByTime(30_000);

    expect(invalidate).not.toHaveBeenCalled();
  });

  it("refreshes once on the way back, so the tab is never stale", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    setVisibility("hidden");
    sockets[0].receiveInvalidate();
    sockets[0].receiveInvalidate();
    sockets[0].receiveInvalidate();
    expect(invalidate).not.toHaveBeenCalled();

    setVisibility("visible");
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("never aborts requests already in flight", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receiveInvalidate();
    vi.advanceTimersByTime(3_000);

    expect(invalidate).toHaveBeenCalledWith(expect.anything(), { cancelRefetch: false });
  });

  it("keeps heavy stock allocation out of blanket websocket refetches", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receiveInvalidate();
    vi.advanceTimersByTime(3_000);

    const options = invalidate.mock.calls[0]?.[0];
    expect(options?.predicate).toBeTypeOf("function");
    const predicate = options!.predicate!;

    expect(predicate(queryWithKey("/api/factory/v5/stock-allocation"))).toBe(false);
    expect(predicate(queryWithKey("/api/factory/v5/stock-allocation?pagination=1&page=2&limit=50"))).toBe(false);
    expect(predicate(queryWithKey("/api/factory/customer-orders?status=LOADING"))).toBe(true);
  });

  it("shares one socket and keeps it alive when either duplicate hook unmounts first", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const first = renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });
    const second = renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);

    first.unmount();
    expect(sockets[0].close).not.toHaveBeenCalled();

    sockets[0].receiveInvalidate();
    vi.advanceTimersByTime(3_000);
    expect(invalidate).toHaveBeenCalledTimes(1);

    second.unmount();
    expect(sockets[0].close).toHaveBeenCalledTimes(1);
  });
});
