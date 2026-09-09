import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  resetWsInvalidationManagerForTests,
  subscribeRealtimeChatEvents,
  useWsInvalidation,
} from "@/hooks/use-ws-invalidation";

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function queryWithKey(key: string): Query {
  return { queryKey: [key] } as unknown as Query;
}

describe("Wave 2 live-page websocket events", () => {
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

    receive(payload: unknown) {
      this.onmessage?.({ data: JSON.stringify(payload) });
    }
  }

  beforeEach(() => {
    sockets = [];
    visibility = "visible";
    resetWsInvalidationManagerForTests();
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeSocket as unknown as typeof WebSocket);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(true);
  });

  afterEach(() => {
    resetWsInvalidationManagerForTests();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("routes scan invalidations only to scan queries", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receive({ type: "invalidate", topics: ["scans"] });
    vi.advanceTimersByTime(400);

    const predicate = invalidate.mock.calls[0]?.[0].predicate!;
    expect(predicate(queryWithKey("/api/factory/daily-bale-scans"))).toBe(true);
    expect(predicate(queryWithKey("/api/factory/ground-scan-items"))).toBe(true);
    expect(predicate(queryWithKey("/api/factory/customer-orders"))).toBe(false);
    expect(predicate(queryWithKey("/api/accounts"))).toBe(false);
  });

  it("routes presence invalidations only to presence queries", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receive({ type: "invalidate", topics: ["presence"] });
    vi.advanceTimersByTime(400);

    const predicate = invalidate.mock.calls[0]?.[0].predicate!;
    expect(predicate(queryWithKey("/api/user-presence"))).toBe(true);
    expect(predicate(queryWithKey("/api/user-presence/user-7/activity"))).toBe(true);
    expect(predicate(queryWithKey("/api/chat/users"))).toBe(false);
    expect(predicate(queryWithKey("/api/factory/customer-orders"))).toBe(false);
  });

  it("delivers direct chat events and refreshes only chat metadata", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const events: unknown[] = [];
    const unsubscribe = subscribeRealtimeChatEvents((event) => events.push(event));
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receive({
      type: "message:new",
      message: {
        id: 55,
        senderId: "user-a",
        receiverId: "user-b",
        message: "hello",
        fileUrl: null,
        fileName: null,
        fileType: null,
        fileSize: null,
        readAt: null,
        createdAt: "2026-09-09T06:00:00.000Z",
      },
    });

    expect(events).toHaveLength(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    const predicate = invalidate.mock.calls[0]?.[0].predicate!;
    expect(predicate(queryWithKey("/api/chat/users"))).toBe(true);
    expect(predicate(queryWithKey("/api/chat/unread-count"))).toBe(true);
    expect(predicate(queryWithKey("/api/chat/conversations"))).toBe(false);
    expect(predicate(queryWithKey("/api/accounts"))).toBe(false);
    unsubscribe();
  });

  it("does not refetch metadata for typing events", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    const events: unknown[] = [];
    const unsubscribe = subscribeRealtimeChatEvents((event) => events.push(event));
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    sockets[0].receive({
      type: "typing:update",
      senderId: "user-a",
      receiverId: "user-b",
      isTyping: true,
      until: Date.now() + 5000,
    });

    expect(events).toHaveLength(1);
    expect(invalidate).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("suppresses hidden-tab chat metadata fetches and catches up on visibility", () => {
    const client = new QueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries").mockResolvedValue();
    renderHook(() => useWsInvalidation(), { wrapper: wrapper(client) });

    visibility = "hidden";
    sockets[0].receive({
      type: "message:new",
      message: {
        id: 56,
        senderId: "user-a",
        receiverId: "user-b",
        message: "hidden",
      },
    });
    expect(invalidate).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});
