/**
 * usePresence tells the server which page a user is on (for the remote-support
 * console) with as little traffic as possible: one PATCH per route change at
 * most every 10 seconds, a heartbeat every 90 seconds only while the tab is
 * visible, a beacon on unload, and a full stop on a 401.
 */
import { renderHook } from "@testing-library/react";
import { HEARTBEAT_INTERVAL, usePresence } from "@/hooks/use-presence";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";
import { pageState, resetPageState } from "./pageMocks";

const harness = vi.hoisted(() => ({ markRemoteSupportAuthLost: vi.fn() }));

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/components/remote-support-auth-lifecycle", () => ({
  markRemoteSupportAuthLost: harness.markRemoteSupportAuthLost,
}));

let visibility: DocumentVisibilityState = "visible";
let api: FakeApi;

const presence = () =>
  api.callsTo("PATCH", "/api/user-presence").map((call) => call.body as { route: string; type: string });

function setVisibility(next: DocumentVisibilityState) {
  visibility = next;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-25T08:00:00Z"));
  resetPageState();
  pageState.location = "/vouchers";
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  harness.markRemoteSupportAuthLost.mockReset();
  api = installFakeApi();
  api.patch("/api/user-presence", respond(204));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("usePresence", () => {
  it("reports the current page on mount", () => {
    renderHook(() => usePresence());

    expect(presence()).toEqual([{ route: "/vouchers", type: "route_change" }]);
  });

  it("reports route changes at most once every 10 seconds", () => {
    const { rerender } = renderHook(() => usePresence());

    pageState.location = "/stock";
    rerender();
    expect(presence()).toHaveLength(1);

    vi.advanceTimersByTime(10_000);
    pageState.location = "/customers";
    rerender();

    expect(presence().map((report) => report.route)).toEqual(["/vouchers", "/customers"]);
  });

  it("sends a heartbeat for the latest page every 90 seconds while visible", () => {
    const { rerender } = renderHook(() => usePresence());
    vi.advanceTimersByTime(5_000);
    pageState.location = "/stock";
    rerender();

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL);

    expect(presence().at(-1)).toEqual({ route: "/stock", type: "heartbeat" });
  });

  it("skips heartbeats while the tab is hidden and catches up when it returns", () => {
    renderHook(() => usePresence());
    setVisibility("hidden");

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL * 2);
    expect(presence()).toHaveLength(1);

    setVisibility("visible");
    expect(presence()).toEqual([
      { route: "/vouchers", type: "route_change" },
      { route: "/vouchers", type: "route_change" },
    ]);
  });

  it("does not report a route change from a hidden tab", () => {
    visibility = "hidden";
    renderHook(() => usePresence());

    expect(presence()).toHaveLength(0);
  });

  it("does not re-report on a quick return to the tab", () => {
    renderHook(() => usePresence());

    setVisibility("hidden");
    setVisibility("visible");

    expect(presence()).toHaveLength(1);
  });

  it("stops heartbeats and ends remote support when the session has expired", async () => {
    api.patch("/api/user-presence", respond(401, { message: "Unauthorized" }));
    renderHook(() => usePresence());
    await vi.waitFor(() => expect(harness.markRemoteSupportAuthLost).toHaveBeenCalledTimes(1));

    vi.advanceTimersByTime(HEARTBEAT_INTERVAL * 3);

    expect(presence()).toHaveLength(1);
  });

  it("ignores network failures", async () => {
    api.patch("/api/user-presence", () => Promise.reject(new TypeError("Failed to fetch")));

    expect(() => renderHook(() => usePresence())).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.markRemoteSupportAuthLost).not.toHaveBeenCalled();
  });

  it("sends a leave beacon when the page unloads", () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, "sendBeacon", { configurable: true, value: sendBeacon });
    renderHook(() => usePresence());

    window.dispatchEvent(new Event("beforeunload"));

    expect(sendBeacon).toHaveBeenCalledWith("/api/user-presence/leave", expect.any(Blob));
  });

  it("does nothing when disabled, and stops everything on unmount", () => {
    renderHook(() => usePresence(false));
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL);
    expect(presence()).toHaveLength(0);

    const { unmount } = renderHook(() => usePresence());
    unmount();
    vi.advanceTimersByTime(HEARTBEAT_INTERVAL * 2);
    setVisibility("hidden");
    vi.advanceTimersByTime(20_000);
    setVisibility("visible");

    expect(presence()).toHaveLength(1);
  });
});
