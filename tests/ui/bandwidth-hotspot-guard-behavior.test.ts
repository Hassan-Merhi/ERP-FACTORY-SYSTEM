/**
 * The Phase 1 hotspot guard snapshots the API reads that dominated production
 * bandwidth (inventory, containers, Factory reports...) and shares one network
 * request between concurrent callers. These cases pin what reaches the network:
 * TTLs, per-route size limits, invalidation, eviction, hidden tabs, and how a
 * shared request survives one caller walking away but not all of them.
 */
import { BANDWIDTH_INVALIDATION_CHANNEL } from "@/lib/bandwidthInvalidationPolicy";

type Underlying = ReturnType<typeof vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

const realFetch = globalThis.fetch;
let visibility: DocumentVisibilityState = "visible";
let now = 1_000_000;

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string> | undefined) },
  });
}

async function installGuard(underlying: Underlying): Promise<typeof fetch> {
  globalThis.fetch = underlying as unknown as typeof fetch;
  window.fetch = underlying as unknown as typeof fetch;
  const { installBandwidthPhase1HotspotGuard } = await import("@/lib/bandwidthPhase1HotspotGuard");
  installBandwidthPhase1HotspotGuard();
  return window.fetch;
}

/** The invalidation hook from the module instance the fresh guard registered with. */
async function invalidateReadCaches(scope: "live" | "all"): Promise<void> {
  const { invalidateBandwidthReadCaches } = await import("@/lib/bandwidthInvalidationPolicy");
  invalidateBandwidthReadCaches(scope);
}

function pending(): { promise: Promise<Response>; release: (response: Response) => void } {
  let release!: (response: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  delete (window as any).__bandwidthPhase1HotspotGuardInstalled;
  visibility = "visible";
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as any).__bandwidthPhase1HotspotGuardInstalled;
  vi.restoreAllMocks();
});

describe("hotspot guard — snapshots", () => {
  it("serves a hotspot read from its snapshot within the TTL and drops it after", async () => {
    const underlying: Underlying = vi.fn(async () => json([{ id: 1 }]));
    const guarded = await installGuard(underlying);

    await guarded("/api/inventory");
    await expect((await guarded("/api/inventory")).json()).resolves.toEqual([{ id: 1 }]);
    expect(underlying).toHaveBeenCalledTimes(1);

    now += 30_001;
    await guarded("/api/inventory");
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("leaves reads that are not hotspots, non-API URLs and HEAD requests alone", async () => {
    const underlying: Underlying = vi.fn(async () => new Response("[]"));
    const guarded = await installGuard(underlying);

    await guarded("/api/vouchers");
    await guarded("/api/vouchers");
    await guarded("/assets/app.js");
    await guarded("/api/inventory", { method: "HEAD" });

    expect(underlying).toHaveBeenCalledTimes(4);
  });

  it.each([
    ["Cache-Control: no-cache", { headers: { "Cache-Control": "no-cache" } }],
    ["Cache-Control: no-store", { headers: { "Cache-Control": "no-store" } }],
    ["a no-store request", { cache: "no-store" as RequestCache }],
    ["the bypass header", { headers: { "X-Bypass-Request-Storm-Guard": "1" } }],
  ])("bypasses the snapshot for %s", async (_label, init) => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);

    await guarded("/api/inventory", init);
    await guarded("/api/inventory", init);

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("applies each route's own size limit before snapshotting", async () => {
    const underlying: Underlying = vi.fn(async () => json([], { headers: { "Content-Length": "3000000" } }));
    const guarded = await installGuard(underlying);

    // 3 MB is under the OTW items limit (4 MB) but over the default (1.5 MB).
    await guarded("/api/containers/otw-items");
    await guarded("/api/containers/otw-items");
    await guarded("/api/inventory");
    await guarded("/api/inventory");

    expect(underlying.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/containers/otw-items",
      "/api/inventory",
      "/api/inventory",
    ]);
  });

  it("does not snapshot an error response", async () => {
    const underlying: Underlying = vi.fn(async () => json({ message: "down" }, { status: 500 }));
    const guarded = await installGuard(underlying);

    await guarded("/api/inventory");
    await guarded("/api/inventory");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used snapshot beyond 32 entries", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);

    for (let id = 0; id < 33; id += 1) {
      now += 1;
      await guarded(`/api/locations/${id}/inventory`);
    }
    await guarded("/api/locations/32/inventory");
    expect(underlying).toHaveBeenCalledTimes(33);

    await guarded("/api/locations/0/inventory");
    expect(underlying).toHaveBeenCalledTimes(34);
  });
});

describe("hotspot guard — invalidation", () => {
  it("drops live snapshots on an ordinary write and keeps reference ones", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/inventory");
    await guarded("/api/locations");

    await guarded("/api/stock-adjustments", { method: "POST", body: "{}" });
    await guarded("/api/inventory");
    await guarded("/api/locations");

    expect(underlying.mock.calls.map(([input]) => String(input))).toEqual([
      "/api/inventory",
      "/api/locations",
      "/api/stock-adjustments",
      "/api/inventory",
    ]);
  });

  it("drops every snapshot on a full invalidation", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/locations");

    await invalidateReadCaches("all");
    await guarded("/api/locations");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("does not snapshot a read that a write overtook", async () => {
    const slow = pending();
    let reads = 0;
    const underlying: Underlying = vi.fn(async (input) =>
      String(input) === "/api/inventory" && ++reads === 1 ? slow.promise : json([])
    );
    const guarded = await installGuard(underlying);

    const read = guarded("/api/inventory");
    await flush();
    await guarded("/api/stock-adjustments", { method: "POST", body: "{}" });
    slow.release(json([{ id: "stale" }]));
    await read;
    await guarded("/api/inventory");

    expect(reads).toBe(2);
  });

  it("drops snapshots when another tab broadcasts an invalidation", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/locations");

    const otherTab = new BroadcastChannel(BANDWIDTH_INVALIDATION_CHANNEL);
    otherTab.postMessage({ type: "invalidate", scope: "all" });
    await vi.waitFor(async () => {
      await guarded("/api/locations");
      expect(underlying.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    otherTab.close();
  });
});

describe("hotspot guard — shared requests", () => {
  it("sends one request for concurrent callers and gives each a readable body", async () => {
    const network = pending();
    const underlying: Underlying = vi.fn(() => network.promise);
    const guarded = await installGuard(underlying);

    const first = guarded("/api/containers");
    const second = guarded("/api/containers", { signal: new AbortController().signal });
    await flush();
    network.release(json([{ id: 9 }]));

    expect(underlying).toHaveBeenCalledTimes(1);
    await expect((await first).json()).resolves.toEqual([{ id: 9 }]);
    await expect((await second).json()).resolves.toEqual([{ id: 9 }]);
  });

  it("keeps the shared request alive when only one caller aborts", async () => {
    const network = pending();
    let networkSignal: AbortSignal | undefined;
    const underlying: Underlying = vi.fn((_input, init) => {
      networkSignal = init?.signal ?? undefined;
      return network.promise;
    });
    const guarded = await installGuard(underlying);
    const leaving = new AbortController();

    const first = guarded("/api/containers", { signal: leaving.signal });
    const second = guarded("/api/containers", { signal: new AbortController().signal });
    await flush();
    leaving.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    expect(networkSignal?.aborted).toBe(false);
    network.release(json([]));
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("aborts the network request once every caller has abandoned it, then starts afresh", async () => {
    let networkSignal: AbortSignal | undefined;
    const underlying: Underlying = vi.fn((_input, init) => {
      networkSignal = init?.signal ?? undefined;
      if (underlying.mock.calls.length > 1) return Promise.resolve(json([{ fresh: true }]));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const guarded = await installGuard(underlying);
    const a = new AbortController();
    const b = new AbortController();

    const first = guarded("/api/containers", { signal: a.signal });
    const second = guarded("/api/containers", { signal: b.signal });
    await flush();
    a.abort();
    b.abort();

    await expect(first).rejects.toMatchObject({ name: "AbortError" });
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(networkSignal?.aborted).toBe(true);

    const later = await guarded("/api/containers");
    await expect(later.json()).resolves.toEqual([{ fresh: true }]);
  });

  it("rejects at once for a caller whose signal is already aborted", async () => {
    const network = pending();
    const underlying: Underlying = vi.fn(() => network.promise);
    const guarded = await installGuard(underlying);
    const first = guarded("/api/containers");
    await flush();

    const aborted = new AbortController();
    aborted.abort();
    await expect(guarded("/api/containers", { signal: aborted.signal })).rejects.toMatchObject({
      name: "AbortError",
    });

    network.release(json([]));
    await first;
  });
});

describe("hotspot guard — hidden tabs", () => {
  it("waits for the tab to become visible before sending a hotspot read", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    visibility = "hidden";

    const read = guarded("/api/factory/raw-stock");
    await flush();
    expect(underlying).not.toHaveBeenCalled();

    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(underlying).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await read;
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("rejects a hidden-tab read its caller abandons, without sending it", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    visibility = "hidden";
    const controller = new AbortController();

    const read = guarded("/api/factory/raw-stock", { signal: controller.signal });
    controller.abort();

    await expect(read).rejects.toMatchObject({ name: "AbortError" });
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(underlying).not.toHaveBeenCalled();
  });

  it("rejects a hidden-tab read whose signal is already aborted", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    visibility = "hidden";
    const controller = new AbortController();
    controller.abort();

    await expect(guarded("/api/factory/raw-stock", { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(underlying).not.toHaveBeenCalled();
  });
});
