import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  computeWsReconnectDelayMs,
  resetWsInvalidationManagerForTests,
  useWsInvalidation,
} from "@/hooks/use-ws-invalidation";

/**
 * Every write in the system broadcasts, and every broadcast makes each
 * receiving client refetch what it has on screen. These tests keep that traffic
 * bounded during write bursts, hidden tabs, duplicate mounts, and network loss.
 */
describe("WebSocket invalidation traffic", () => {
  let sockets: FakeSocket[];
  let visibility: DocumentVisibilityState;
  let online: boolean;

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

  function setOnline(next: boolean) {
    online = next;
    window.dispatchEvent(new Event(next ? "online" : "offline"));
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
    online = true;
    resetWsInvalidationManagerForTests();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(window.navigator, "onLine", "get").mockImplementation(() => online);
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

  it("backs off repeated reconnect failures and resets after a successful connection", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const client = new QueryClient();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);
    sockets[0].onclose?.();
    vi.advanceTimersByTime(1_499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].onclose?.();
    vi.advanceTimersByTime(2_999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);

    sockets[2].onopen?.();
    sockets[2].onclose?.();
    vi.advanceTimersByTime(1_499);
    expect(sockets).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(4);
  });

  it("keeps a healthy socket open when navigator emits a false offline hint", () => {
    const client = new QueryClient();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    setOnline(false);

    expect(sockets[0].close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(90_000);
    expect(sockets).toHaveLength(1);
  });

  it("probes sparingly after the socket actually closes while navigator reports offline", () => {
    const client = new QueryClient();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    setOnline(false);
    expect(sockets[0].close).not.toHaveBeenCalled();

    sockets[0].onclose?.();
    vi.advanceTimersByTime(29_999);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);

    sockets[1].onopen?.();
    vi.advanceTimersByTime(90_000);
    expect(sockets).toHaveLength(2);
  });

  it("reconnects immediately when the browser reports connectivity restored after a disconnect", () => {
    const client = new QueryClient();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(1);
    sockets[0].onopen?.();
    setOnline(false);
    sockets[0].onclose?.();

    vi.advanceTimersByTime(10_000);
    expect(sockets).toHaveLength(1);

    setOnline(true);
    expect(sockets).toHaveLength(2);

    vi.advanceTimersByTime(30_000);
    expect(sockets).toHaveLength(2);
  });

  it("catches up after a delayed initial probe when navigator begins offline", () => {
    online = false;
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    expect(sockets).toHaveLength(0);
    vi.advanceTimersByTime(29_999);
    expect(sockets).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();

    sockets[0].onopen?.();
    vi.advanceTimersByTime(2_999);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });

  it("caps reconnect backoff at thirty seconds", () => {
    expect(computeWsReconnectDelayMs(0, 0.5)).toBe(1_500);
    expect(computeWsReconnectDelayMs(1, 0.5)).toBe(3_000);
    expect(computeWsReconnectDelayMs(2, 0.5)).toBe(6_000);
    expect(computeWsReconnectDelayMs(5, 0.5)).toBe(30_000);
    expect(computeWsReconnectDelayMs(10, 1)).toBe(30_000);
  });
});
