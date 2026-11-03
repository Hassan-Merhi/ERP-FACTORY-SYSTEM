/**
 * useRemoteControlSession tells a target tab whether a support agent is
 * controlling it. It sends a heartbeat on mount, every 12 seconds and when the
 * tab becomes visible, follows the server's control event stream, accepts only
 * well-formed active sessions, stops a session on the user's emergency stop,
 * and goes quiet (and reports lost auth) once the server answers 401.
 */
import { act, renderHook, waitFor } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  authLost: vi.fn(),
  location: "/sales",
}));

vi.mock("@/lib/queryClient", () => ({ apiRequest: harness.apiRequest }));
vi.mock("@/components/remote-support-auth-lifecycle", () => ({ markRemoteSupportAuthLost: harness.authLost }));
vi.mock("wouter", () => ({ useLocation: () => [harness.location, vi.fn()] }));

import { getRemoteSupportTabId, useRemoteControlSession } from "@/hooks/use-remote-control-session";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  constructor(
    readonly url: string,
    readonly init?: EventSourceInit
  ) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: { data: string }) => void) {
    this.listeners.set(type, listener);
  }
  emit(data: unknown) {
    this.listeners.get("control")?.({ data: typeof data === "string" ? data : JSON.stringify(data) });
  }
  close() {
    this.closed = true;
  }
}

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "s-1",
  companyId: 4,
  status: "active",
  targetTabId: "tab-1",
  targetRoute: "/sales",
  ...overrides,
});
const answer = (body: unknown, status = 200) => ({ status, json: async () => body });
const unauthorized = () => Object.assign(new Error("401"), { status: 401 });
const heartbeats = () =>
  harness.apiRequest.mock.calls.filter(([, url]) => url === "/api/screen-feed/control/tab-heartbeat");

const realEventSource = globalThis.EventSource;
beforeEach(() => {
  harness.apiRequest.mockReset();
  harness.authLost.mockReset();
  harness.location = "/sales";
  FakeEventSource.instances = [];
  globalThis.EventSource = FakeEventSource as unknown as typeof EventSource;
  sessionStorage.clear();
});
afterEach(() => {
  globalThis.EventSource = realEventSource;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getRemoteSupportTabId", () => {
  it("keeps one id per tab", () => {
    const id = getRemoteSupportTabId();

    expect(getRemoteSupportTabId()).toBe(id);
    expect(sessionStorage.getItem("remote-support-browser-tab-id")).toBe(id);
  });

  it("still returns an id when tab storage is unavailable, even without randomUUID", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const uuid = Object.getOwnPropertyDescriptor(globalThis.crypto, "randomUUID");
    Object.defineProperty(globalThis.crypto, "randomUUID", { configurable: true, value: undefined });
    try {
      expect(getRemoteSupportTabId()).toMatch(/^tab-\d+-/);
    } finally {
      if (uuid) Object.defineProperty(globalThis.crypto, "randomUUID", uuid);
    }
  });
});

describe("useRemoteControlSession", () => {
  it("reports the active session from its heartbeat, with the tab and route", async () => {
    harness.apiRequest.mockResolvedValue(answer({ session: session() }));

    const { result } = renderHook(() => useRemoteControlSession());

    await waitFor(() => expect(result.current.session?.id).toBe("s-1"));
    expect(heartbeats()[0][2]).toEqual({ tabId: result.current.tabId, route: "/sales" });
    const stream = FakeEventSource.instances[0];
    expect(stream.url).toContain("/api/screen-feed/control/status?");
    expect(new URL(stream.url, "http://x").searchParams.get("route")).toBe("/sales");
    expect(stream.init).toEqual({ withCredentials: true });
  });

  it.each([
    ["no session", answer({}, 204)],
    ["a stopped session", answer({ session: session({ status: "stopped" }) })],
    ["a session without a tab", answer({ session: session({ targetTabId: "" }) })],
    ["a session with a bad company", answer({ session: session({ companyId: "4" }) })],
    ["a session without a route", answer({ session: session({ targetRoute: null }) })],
    ["a list instead of a session", answer({ session: [session()] })],
  ])("shows nothing for %s", async (_label, response) => {
    harness.apiRequest.mockResolvedValue(response);

    const { result } = renderHook(() => useRemoteControlSession());

    await waitFor(() => expect(heartbeats()).toHaveLength(1));
    await act(async () => {});
    expect(result.current.session).toBeNull();
  });

  it("beats every 12 seconds and when the tab becomes visible again", async () => {
    vi.useFakeTimers();
    harness.apiRequest.mockResolvedValue(answer({}, 204));
    const { unmount } = renderHook(() => useRemoteControlSession());
    await act(async () => {});
    expect(heartbeats()).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });
    expect(heartbeats()).toHaveLength(2);

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(heartbeats()).toHaveLength(2);
    visibility.mockReturnValue("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(heartbeats()).toHaveLength(3);

    unmount();
    await vi.advanceTimersByTimeAsync(36_000);
    expect(heartbeats()).toHaveLength(3);
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it("clears an ended session when a heartbeat answers 204 with no body", async () => {
    vi.useFakeTimers();
    const noContent = {
      status: 204,
      json: async () => {
        throw new SyntaxError("Unexpected end of JSON input");
      },
    };
    harness.apiRequest.mockResolvedValueOnce(answer({ session: session() })).mockResolvedValue(noContent);
    const { result } = renderHook(() => useRemoteControlSession());
    await act(async () => {});
    expect(result.current.session?.id).toBe("s-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(result.current.session).toBeNull();
  });

  it("follows control events and ignores malformed ones", async () => {
    harness.apiRequest.mockResolvedValue(answer({}, 204));
    const { result } = renderHook(() => useRemoteControlSession());
    await waitFor(() => expect(heartbeats()).toHaveLength(1));
    const stream = FakeEventSource.instances[0];

    act(() => stream.emit({ session: session({ id: "s-2" }) }));
    expect(result.current.session?.id).toBe("s-2");
    act(() => stream.emit("{not json"));
    expect(result.current.session?.id).toBe("s-2");
    act(() => stream.emit({ session: null }));
    expect(result.current.session).toBeNull();
  });

  it("keeps working without an event stream and through a failed heartbeat", async () => {
    globalThis.EventSource = class {
      constructor() {
        throw new Error("unsupported");
      }
    } as unknown as typeof EventSource;
    harness.apiRequest.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(answer({ session: session() }));
    vi.useFakeTimers();
    const { result } = renderHook(() => useRemoteControlSession());
    await act(async () => {});
    expect(result.current.session).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(12_000);
    });

    expect(result.current.session?.id).toBe("s-1");
    expect(harness.authLost).not.toHaveBeenCalled();
  });

  it("stops the session on an emergency stop, and does nothing once it is gone", async () => {
    harness.apiRequest.mockImplementation(async (_method, url) =>
      url.endsWith("/stop") ? answer({}) : answer({ session: session({ id: "s/1" }) })
    );
    const { result } = renderHook(() => useRemoteControlSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await result.current.stop();
    });

    const stops = harness.apiRequest.mock.calls.filter(([, url]) => url.endsWith("/stop"));
    expect(stops).toEqual([
      ["POST", "/api/screen-feed/control/sessions/s%2F1/stop", { reason: "target-emergency-stop" }],
    ]);
    expect(result.current.session).toBeNull();
    expect(result.current.stopping).toBe(false);

    await act(async () => {
      await result.current.stop();
    });
    expect(harness.apiRequest.mock.calls.filter(([, url]) => url.endsWith("/stop"))).toHaveLength(1);
  });

  it("surfaces a failed stop that is not an auth failure", async () => {
    harness.apiRequest.mockImplementation(async (_method, url) => {
      if (url.endsWith("/stop")) throw new Error("Server error");
      return answer({ session: session() });
    });
    const { result } = renderHook(() => useRemoteControlSession());
    await waitFor(() => expect(result.current.session).not.toBeNull());

    await act(async () => {
      await expect(result.current.stop()).rejects.toThrow("Server error");
    });
    expect(result.current.session?.id).toBe("s-1");
    expect(result.current.stopping).toBe(false);
  });

  it("goes quiet and reports lost auth on a 401, from a heartbeat or a stop", async () => {
    vi.useFakeTimers();
    harness.apiRequest.mockRejectedValue(unauthorized());
    renderHook(() => useRemoteControlSession());
    await act(async () => {});
    expect(harness.authLost).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.instances.every((stream) => stream.closed)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(36_000);
    });
    expect(heartbeats()).toHaveLength(1);
    vi.useRealTimers();

    harness.apiRequest.mockReset();
    harness.authLost.mockReset();
    harness.apiRequest.mockImplementation(async (_method, url) => {
      if (url.endsWith("/stop")) throw unauthorized();
      return answer({ session: session() });
    });
    const second = renderHook(() => useRemoteControlSession());
    await waitFor(() => expect(second.result.current.session).not.toBeNull());

    await act(async () => {
      await second.result.current.stop();
    });

    expect(second.result.current.session).toBeNull();
    expect(harness.authLost).toHaveBeenCalledTimes(1);
  });
});
