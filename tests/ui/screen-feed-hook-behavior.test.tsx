/**
 * useScreenFeed runs in every ERP tab and streams it to a support agent only
 * while someone is watching. It binds to the screen-feed socket (or polls when
 * the socket is down), captures a frame as soon as watching starts and after
 * clicks, input, scrolling, navigation and visible DOM changes, sends the
 * cursor at most every 100 ms when it moved, reports failed captures, and
 * stops every capture, timer and observer when watching ends, the tab is
 * hidden, or the hook unmounts.
 */
import { act, renderHook } from "@testing-library/react";

const harness = vi.hoisted(() => ({
  send: vi.fn((_message: Record<string, unknown>) => true),
  listeners: new Set<(message: Record<string, unknown>) => void>(),
  unsubscribe: vi.fn(),
  capture: vi.fn(),
}));

vi.mock("@/lib/screen-feed-binary-transport", () => ({
  sendScreenFeedControlMessage: harness.send,
  subscribeScreenFeedTransportStatus: (listener: (message: Record<string, unknown>) => void) => {
    harness.listeners.add(listener);
    return () => {
      harness.listeners.delete(listener);
      harness.unsubscribe();
    };
  },
}));
vi.mock("@/hooks/screen-feed-capture-engine", () => ({ captureAndUploadScreenFrame: harness.capture }));
vi.mock("@/hooks/use-remote-control-session", () => ({ getRemoteSupportTabId: () => "tab-1" }));

import { useScreenFeed } from "@/hooks/use-screen-feed";

type CaptureInput = {
  fast: boolean;
  lastSignature: string | null;
  expectedPath: string;
  clicks: Array<{ label: string }>;
  cursor: { visible: boolean } | null;
  scrollElements: Set<HTMLElement>;
  shouldContinue: () => boolean;
};

const ok = (overrides: Record<string, unknown> = {}) => ({
  uploaded: true,
  unchanged: false,
  failed: false,
  cancelled: false,
  signature: "sig-1",
  latestClickTs: 0,
  durationMs: 10,
  ...overrides,
});

const fetchMock = vi.fn();
const realFetch = globalThis.fetch;
let visibility: DocumentVisibilityState = "visible";

function emit(message: Record<string, unknown>) {
  act(() => harness.listeners.forEach((listener) => listener(message)));
}
const sent = (type: string) => harness.send.mock.calls.map(([message]) => message).filter((m) => m.type === type);
const captures = () => harness.capture.mock.calls.map(([input]) => input as CaptureInput);
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

async function watch(fast = false) {
  // As in the app: the start-up fallback poll ("not watched") lands, the socket
  // binds and stops that poll, then the server says the tab is watched.
  await advance(0);
  emit({ type: "screen-feed:producer-bound" });
  emit({ type: "screen-feed:status", watched: true, fast });
  await advance(50);
}

beforeEach(() => {
  vi.useFakeTimers();
  harness.send.mockReset().mockReturnValue(true);
  harness.unsubscribe.mockReset();
  harness.listeners.clear();
  harness.capture.mockReset().mockResolvedValue(ok());
  fetchMock.mockReset().mockResolvedValue(new Response(JSON.stringify({ watched: false }), { status: 200 }));
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  window.history.replaceState({}, "", "/sales");
  document.body.innerHTML = "";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("binding and watch status", () => {
  it("binds the producer when the socket is ready and stops the fallback poll", async () => {
    renderHook(() => useScreenFeed());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/screen-feed/being-watched?tabId=tab-1");

    emit({ type: "screen-feed-transport-ready" });
    await advance(20_000);

    expect(sent("screen-feed:producer-bind")).toEqual([{ type: "screen-feed:producer-bind", tabId: "tab-1" }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps polling every five seconds while the socket cannot bind, and after it disconnects", async () => {
    harness.send.mockReturnValue(false);
    renderHook(() => useScreenFeed());

    emit({ type: "screen-feed-transport-ready" });
    await advance(10_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    emit({ type: "screen-feed:producer-bound" });
    const afterBound = fetchMock.mock.calls.length;
    await advance(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(afterBound);

    emit({ type: "screen-feed-transport-disconnected" });
    await advance(5_000);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(afterBound);
  });

  it("starts watching from the fallback poll, and treats a refused or failed poll as not watched", async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ watched: true, fast: true }), { status: 200 }));
    renderHook(() => useScreenFeed());
    await advance(50);
    expect(captures()[0]).toMatchObject({ fast: true, expectedPath: "http://localhost:3000/sales" });

    // A refused poll means "not watched", whatever its body says.
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ watched: true }), { status: 503 }));
    await advance(15_000);
    harness.capture.mockClear();
    document.body.append(document.createElement("p"));
    await advance(5_000);
    expect(harness.capture).not.toHaveBeenCalled();

    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await advance(5_000);
    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("captures as soon as watching starts, and again when the quality mode changes", async () => {
    renderHook(() => useScreenFeed());
    await watch();
    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({ fast: false, lastSignature: null, cursor: null });

    emit({ type: "screen-feed:status", watched: true, fast: false });
    await advance(1_000);
    expect(captures()).toHaveLength(1);

    emit({ type: "screen-feed:status", watched: true, fast: true });
    await advance(1_000);
    expect(captures()).toHaveLength(2);
    expect(captures()[1]).toMatchObject({ fast: true, lastSignature: null });
  });

  it("stops capturing once nobody is watching", async () => {
    renderHook(() => useScreenFeed());
    await watch();
    const input = captures()[0];
    expect(input.shouldContinue()).toBe(true);

    emit({ type: "screen-feed:status", watched: false });
    expect(input.shouldContinue()).toBe(false);
    // The cursor loop and capture timers are gone, not just idling.
    expect(vi.getTimerCount()).toBe(0);
    harness.capture.mockClear();
    window.dispatchEvent(new MouseEvent("click", { clientX: 5, clientY: 5 }));
    document.body.append(document.createElement("p"));
    await advance(70_000);

    expect(harness.capture).not.toHaveBeenCalled();
  });
});

describe("what triggers a new frame", () => {
  it("records clicks with a short label, skipping ignored areas and keeping the last 50", async () => {
    document.body.innerHTML = `
      <button id="save" aria-label="Save invoice">S</button>
      <input id="qty" placeholder="Quantity" />
      <div data-screenfeed-ignore="true"><button id="hidden">Secret</button></div>
      <span id="plain">${"x".repeat(80)}</span>`;
    renderHook(() => useScreenFeed());
    await watch();
    harness.capture.mockClear();

    document.getElementById("save")!.click();
    document.getElementById("hidden")!.click();
    await advance(300);
    expect(captures()[0].clicks.map((click) => click.label)).toEqual(["Save invoice"]);

    for (let i = 0; i < 55; i += 1) document.getElementById("plain")!.click();
    document.getElementById("qty")!.click();
    await advance(300);
    const clicks = captures().at(-1)!.clicks;
    expect(clicks).toHaveLength(50);
    expect(clicks.at(-1)!.label).toBe("Quantity");
    expect(clicks[0].label).toHaveLength(60);
  });

  it("captures after input, scrolling, resizing and navigation", async () => {
    document.body.innerHTML = `<input id="field" /><div id="list"></div><div data-screenfeed-ignore="true"><input id="ignored" /></div>`;
    renderHook(() => useScreenFeed());
    await watch();

    const trigger = async (fire: () => void) => {
      harness.capture.mockClear();
      fire();
      await advance(1_000);
      return harness.capture.mock.calls.length;
    };

    expect(
      await trigger(() => document.getElementById("field")!.dispatchEvent(new Event("input", { bubbles: true })))
    ).toBe(1);
    expect(
      await trigger(() => document.getElementById("ignored")!.dispatchEvent(new Event("input", { bubbles: true })))
    ).toBe(0);
    expect(await trigger(() => document.getElementById("list")!.dispatchEvent(new Event("scroll")))).toBe(1);
    expect(captures()[0].scrollElements.has(document.getElementById("list")!)).toBe(true);
    expect(await trigger(() => window.dispatchEvent(new Event("resize")))).toBe(1);
    expect(captures()[0].lastSignature).toBeNull();
    expect(
      await trigger(() => {
        window.history.pushState({}, "", "/sales/7");
        window.dispatchEvent(new PopStateEvent("popstate"));
      })
    ).toBe(1);
    expect(captures()[0].expectedPath).toBe("http://localhost:3000/sales/7");
    expect(await trigger(() => window.dispatchEvent(new HashChangeEvent("hashchange")))).toBe(1);
  });

  it("captures at once, with a fresh signature, when the URL changed without a navigation event", async () => {
    document.body.innerHTML = `<button id="tab">Tab</button>`;
    harness.capture.mockResolvedValue(ok({ signature: "page-1" }));
    renderHook(() => useScreenFeed());
    await watch();
    await advance(1_000);
    harness.capture.mockClear();

    window.history.pushState({}, "", "/sales/9");
    document.getElementById("tab")!.click();
    await advance(20);

    expect(captures()).toHaveLength(1);
    expect(captures()[0]).toMatchObject({ expectedPath: "http://localhost:3000/sales/9", lastSignature: null });
  });

  it("captures after visible DOM changes but not after changes inside ignored areas", async () => {
    document.body.innerHTML = `<div id="live"></div><div id="overlay" data-screenfeed-ignore="true"></div>`;
    renderHook(() => useScreenFeed());
    await watch();
    harness.capture.mockClear();

    document.getElementById("overlay")!.append(document.createElement("span"));
    document.getElementById("overlay")!.setAttribute("class", "moved");
    await advance(10_000);
    expect(harness.capture).not.toHaveBeenCalled();

    document.getElementById("live")!.textContent = "Updated";
    await advance(10_000);
    expect(harness.capture).toHaveBeenCalledTimes(1);

    harness.capture.mockClear();
    document.getElementById("live")!.setAttribute("data-state", "open");
    await advance(10_000);
    expect(harness.capture).toHaveBeenCalledTimes(1);
  });

  it("keeps the last signature for the next frame and refreshes an idle feed every minute", async () => {
    harness.capture
      .mockResolvedValueOnce(ok({ signature: "first" }))
      .mockResolvedValue(ok({ uploaded: false, unchanged: true, signature: "same" }));
    renderHook(() => useScreenFeed());
    await watch();

    await advance(60_000);
    expect(captures()).toHaveLength(2);
    expect(captures()[1].lastSignature).toBe("first");

    await advance(60_000);
    expect(captures()[2].lastSignature).toBe("same");
  });
});

describe("cursor", () => {
  it("sends the cursor only when it moved, and hides it when the pointer leaves", async () => {
    renderHook(() => useScreenFeed());
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 10, clientY: 10 }));
    await advance(200);
    expect(sent("screen-feed:cursor")).toHaveLength(0);

    await watch();
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 50 }));
    await advance(100);
    expect(sent("screen-feed:cursor")).toHaveLength(1);
    expect(sent("screen-feed:cursor")[0]).toMatchObject({ tabId: "tab-1", cursor: { visible: true } });

    await advance(300);
    expect(sent("screen-feed:cursor")).toHaveLength(1);

    document.documentElement.dispatchEvent(new Event("pointerleave"));
    await advance(100);
    expect(sent("screen-feed:cursor").at(-1)).toMatchObject({ cursor: { visible: false } });
  });

  it("tries again when the socket did not take the cursor update", async () => {
    renderHook(() => useScreenFeed());
    await watch();
    harness.send.mockReturnValueOnce(false);
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 50 }));

    await advance(200);

    expect(sent("screen-feed:cursor")).toHaveLength(2);
  });
});

describe("failures", () => {
  it("reports a failed frame and retries after a backoff", async () => {
    harness.capture
      .mockResolvedValueOnce(
        ok({ uploaded: false, failed: true, failureStage: "encode", failureReason: "Canvas tainted" })
      )
      .mockResolvedValue(ok());
    renderHook(() => useScreenFeed());
    await watch();

    expect(sent("screen-feed:failure")).toEqual([
      {
        type: "screen-feed:failure",
        tabId: "tab-1",
        failure: expect.objectContaining({ stage: "encode", reason: "Canvas tainted", durationMs: 10 }),
      },
    ]);
    await advance(3_000);
    expect(captures()).toHaveLength(1);
    await advance(1_000);
    expect(captures()).toHaveLength(2);
  });

  it("reports a failed frame without details as a pipeline failure", async () => {
    harness.capture.mockResolvedValueOnce(ok({ uploaded: false, failed: true })).mockResolvedValue(ok());
    renderHook(() => useScreenFeed());
    await watch();

    expect(sent("screen-feed:failure")[0]).toMatchObject({
      failure: { stage: "pipeline", reason: "Screen frame could not be produced or uploaded." },
    });
  });

  it("reports a crashed capture, with its message or a generic one", async () => {
    harness.capture.mockRejectedValueOnce(new Error("  html2canvas exploded  ")).mockRejectedValueOnce("??");
    renderHook(() => useScreenFeed());
    await watch();
    await advance(10_000);

    expect(sent("screen-feed:failure").map((message) => (message.failure as { reason: string }).reason)).toEqual([
      "html2canvas exploded",
      "Unexpected screen capture pipeline failure.",
    ]);
  });

  it("re-queues a cancelled frame for the next change", async () => {
    harness.capture
      .mockResolvedValueOnce(ok({ uploaded: false, cancelled: true, signature: null }))
      .mockResolvedValue(ok());
    renderHook(() => useScreenFeed());
    await watch();
    expect(captures()).toHaveLength(1);

    await advance(1_000);

    expect(captures()).toHaveLength(2);
  });
});

describe("hidden tab and unmount", () => {
  it("pauses while the tab is hidden and resumes with a fresh frame when visible", async () => {
    renderHook(() => useScreenFeed());
    await watch();
    harness.capture.mockClear();

    visibility = "hidden";
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 100, clientY: 50 }));
    document.body.append(document.createElement("p"));
    await advance(5_000);
    expect(harness.capture).not.toHaveBeenCalled();
    expect(sent("screen-feed:cursor")).toHaveLength(0);

    visibility = "visible";
    harness.send.mockClear();
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await advance(100);
    expect(sent("screen-feed:producer-bind")).toHaveLength(1);
    expect(harness.capture).toHaveBeenCalledTimes(1);
    expect(captures()[0].lastSignature).toBeNull();
  });

  it("drops a frame that became due while the tab was hidden", async () => {
    renderHook(() => useScreenFeed());
    await watch();
    harness.capture.mockClear();
    window.dispatchEvent(new Event("resize"));
    visibility = "hidden";

    await advance(5_000);

    expect(harness.capture).not.toHaveBeenCalled();
  });

  it("does not poll while hidden", async () => {
    visibility = "hidden";
    renderHook(() => useScreenFeed());
    await advance(20_000);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("stops everything on unmount", async () => {
    const { unmount } = renderHook(() => useScreenFeed());
    await watch();
    harness.capture.mockClear();
    fetchMock.mockClear();

    unmount();
    window.dispatchEvent(new MouseEvent("click"));
    document.body.append(document.createElement("p"));
    await advance(70_000);

    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.capture).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
