/**
 * The request storm guard sits in front of every API GET: it serves short-lived
 * snapshots of hot reference reads, revalidates them with ETags, drops them on
 * any write, caps concurrent GETs and holds heavy reads while the tab is hidden.
 * Each case below pins one of those promises by what reaches the network.
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
  await import("@/lib/requestStormGuard");
  return window.fetch;
}

/**
 * The realtime invalidation hook, from the same module instance the freshly
 * imported guard registered with (vi.resetModules gives each test its own).
 */
async function invalidateReadCaches(scope: "live" | "all"): Promise<void> {
  const { invalidateBandwidthReadCaches } = await import("@/lib/bandwidthInvalidationPolicy");
  invalidateBandwidthReadCaches(scope);
}

function servedBy(underlying: Underlying): string[] {
  return underlying.mock.calls.map(([input]) => String(input));
}

/** Let queued microtasks (slot hand-offs, shared-response clones) run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.resetModules();
  delete (window as any).__requestStormGuardInstalled;
  visibility = "visible";
  now = 1_000_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete (window as any).__requestStormGuardInstalled;
  vi.restoreAllMocks();
});

describe("request storm guard — snapshot cache", () => {
  it("serves a repeated reference read from its snapshot until the TTL lapses", async () => {
    const underlying: Underlying = vi.fn(async () => json([{ id: 1 }]));
    const guarded = await installGuard(underlying);

    await (await guarded("/api/customers")).json();
    await expect((await guarded("/api/customers")).json()).resolves.toEqual([{ id: 1 }]);
    expect(underlying).toHaveBeenCalledTimes(1);

    now += 30 * 60_000 + 1;
    await guarded("/api/customers");
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("keys snapshots by company header, so one company never sees another's rows", async () => {
    const underlying: Underlying = vi.fn(async (_input, init) =>
      json({ company: new Headers(init?.headers).get("x-company-id") })
    );
    const guarded = await installGuard(underlying);

    await guarded("/api/customers", { headers: { "X-Company-Id": "1" } });
    const second = await guarded("/api/customers", { headers: { "X-Company-Id": "2" } });

    expect(underlying).toHaveBeenCalledTimes(2);
    await expect(second.json()).resolves.toEqual({ company: "2" });
  });

  it("does not snapshot reads without a cache rule", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);

    await guarded("/api/vouchers?page=1");
    await guarded("/api/vouchers?page=1");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("does not snapshot an error response", async () => {
    const underlying: Underlying = vi.fn(async () => json({ message: "down" }, { status: 503 }));
    const guarded = await installGuard(underlying);

    await guarded("/api/customers");
    await guarded("/api/customers");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("does not snapshot a response larger than the cacheable limit", async () => {
    const underlying: Underlying = vi.fn(async () => json([], { headers: { "Content-Length": "2000000" } }));
    const guarded = await installGuard(underlying);

    await guarded("/api/customers");
    await guarded("/api/customers");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("evicts the least recently used snapshot beyond 32 entries", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);

    for (let index = 0; index < 33; index += 1) {
      now += 1;
      await guarded(`/api/customers?variant=${index}`);
    }
    await guarded("/api/customers?variant=32");
    expect(underlying).toHaveBeenCalledTimes(33);

    await guarded("/api/customers?variant=0");
    expect(underlying).toHaveBeenCalledTimes(34);
  });

  it.each([
    ["an export path", "/api/customers/export", {}],
    ["a no-store request", "/api/customers", { cache: "no-store" as RequestCache }],
    ["a reload request", "/api/customers", { cache: "reload" as RequestCache }],
    ["the bypass header", "/api/customers", { headers: { "X-Bypass-Request-Storm-Guard": "1" } }],
    ["a Cache-Control: no-store header", "/api/customers", { headers: { "Cache-Control": "no-store" } }],
    ["a range request", "/api/customers", { headers: { Range: "bytes=0-10" } }],
  ])("passes %s straight through, uncached", async (_label, url, init) => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);

    await guarded(url, init);
    await guarded(url, init);

    expect(underlying).toHaveBeenCalledTimes(2);
    expect(underlying.mock.calls[0][1]).toBe(init);
  });

  it("leaves non-API and HEAD requests to the real fetch untouched", async () => {
    const underlying: Underlying = vi.fn(async () => new Response(null));
    const guarded = await installGuard(underlying);
    const init = { method: "HEAD" };

    await guarded("/assets/logo.svg");
    await guarded("/api/customers", init);

    expect(servedBy(underlying)).toEqual(["/assets/logo.svg", "/api/customers"]);
    expect(underlying.mock.calls[1][1]).toBe(init);
  });
});

describe("request storm guard — invalidation", () => {
  it("drops live snapshots on an ordinary write but keeps reference snapshots", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/factory/customer-orders");
    await guarded("/api/customers");

    await guarded("/api/factory/customer-orders/7/notes", { method: "POST", body: "{}" });
    await guarded("/api/factory/customer-orders");
    await guarded("/api/customers");

    expect(servedBy(underlying)).toEqual([
      "/api/factory/customer-orders",
      "/api/customers",
      "/api/factory/customer-orders/7/notes",
      "/api/factory/customer-orders",
    ]);
  });

  it("drops every snapshot on a write to a full-invalidation path", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/customers");

    await guarded("/api/companies/1", { method: "PATCH", body: "{}" });
    await guarded("/api/customers");

    expect(underlying).toHaveBeenCalledTimes(3);
  });

  it("does not cache a read that started before a write finished", async () => {
    let release!: (response: Response) => void;
    const underlying: Underlying = vi.fn(async (input) =>
      String(input) === "/api/factory/customer-orders" && underlying.mock.calls.length === 1
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : json([])
    );
    const guarded = await installGuard(underlying);

    const read = guarded("/api/factory/customer-orders");
    await flush();
    await guarded("/api/factory/customer-orders/7/notes", { method: "POST", body: "{}" });
    release(json([{ id: "stale" }]));
    await read;
    await guarded("/api/factory/customer-orders");

    expect(servedBy(underlying).filter((url) => url === "/api/factory/customer-orders")).toHaveLength(2);
  });

  it("drops snapshots when a realtime message invalidates the read caches", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/customers");

    await invalidateReadCaches("all");
    await guarded("/api/customers");

    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("drops snapshots when another tab broadcasts an invalidation", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    await guarded("/api/customers");

    const otherTab = new BroadcastChannel(BANDWIDTH_INVALIDATION_CHANNEL);
    otherTab.postMessage({ type: "invalidate", scope: "all" });
    await vi.waitFor(async () => {
      await guarded("/api/customers");
      expect(underlying.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    otherTab.close();
  });
});

describe("request storm guard — conditional revalidation", () => {
  it("revalidates an expired snapshot with If-None-Match and reuses its body on 304", async () => {
    const underlying: Underlying = vi.fn(async (_input, init) =>
      new Headers(init?.headers).get("if-none-match") === '"v1"'
        ? new Response(null, { status: 304 })
        : json([{ id: 1 }], { headers: { ETag: '"v1"' } })
    );
    const guarded = await installGuard(underlying);
    await guarded("/api/customers");

    now += 30 * 60_000 + 1;
    const revalidated = await guarded("/api/customers");

    expect(new Headers(underlying.mock.calls[1][1]?.headers).get("if-none-match")).toBe('"v1"');
    expect(revalidated.status).toBe(200);
    await expect(revalidated.json()).resolves.toEqual([{ id: 1 }]);

    // The 304 refreshed the snapshot, so the next read inside the TTL stays local.
    await guarded("/api/customers");
    expect(underlying).toHaveBeenCalledTimes(2);
  });

  it("revalidates instead of serving the body after a write keeps only the validator", async () => {
    const underlying: Underlying = vi.fn(async (_input, init) =>
      new Headers(init?.headers).get("if-none-match")
        ? new Response(null, { status: 304 })
        : json([{ id: 1 }], { headers: { ETag: '"v1"' } })
    );
    const guarded = await installGuard(underlying);
    await guarded("/api/customers");

    await invalidateReadCaches("all");
    const afterWrite = await guarded("/api/customers");

    expect(underlying).toHaveBeenCalledTimes(2);
    expect(new Headers(underlying.mock.calls[1][1]?.headers).get("if-none-match")).toBe('"v1"');
    await expect(afterWrite.json()).resolves.toEqual([{ id: 1 }]);
  });
});

describe("request storm guard — concurrency and hidden tabs", () => {
  it("runs at most six API GETs at once and starts the next as one finishes", async () => {
    const releases: Array<() => void> = [];
    const underlying: Underlying = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(json([])));
        })
    );
    const guarded = await installGuard(underlying);

    const requests = Array.from({ length: 7 }, (_, index) => guarded(`/api/vouchers?page=${index}`));
    await flush();
    expect(underlying).toHaveBeenCalledTimes(6);

    releases[0]();
    await flush();
    expect(underlying).toHaveBeenCalledTimes(7);

    releases.slice(1).forEach((release) => release());
    await Promise.all(requests);
  });

  it("rejects a queued GET whose caller aborts, without ever sending it", async () => {
    const releases: Array<() => void> = [];
    const underlying: Underlying = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(json([])));
        })
    );
    const guarded = await installGuard(underlying);
    const busy = Array.from({ length: 6 }, (_, index) => guarded(`/api/vouchers?page=${index}`));
    await flush();

    const controller = new AbortController();
    const queued = guarded("/api/vouchers?page=queued", { signal: controller.signal });
    controller.abort();

    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    releases.forEach((release) => release());
    await Promise.all(busy);
    await flush();
    expect(servedBy(underlying)).not.toContain("/api/vouchers?page=queued");
  });

  it("holds a heavy read while the tab is hidden and sends it once the tab is visible", async () => {
    const underlying: Underlying = vi.fn(async () => json([]));
    const guarded = await installGuard(underlying);
    visibility = "hidden";

    const read = guarded("/api/factory/raw-stock");
    await flush();
    expect(underlying).not.toHaveBeenCalled();

    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await read;
    expect(underlying).toHaveBeenCalledTimes(1);
  });

  it("aborts a hidden-tab read that its caller abandons before the tab returns", async () => {
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

  it("keeps serving an expired snapshot while the tab is hidden", async () => {
    const underlying: Underlying = vi.fn(async () => json([{ id: 1 }]));
    const guarded = await installGuard(underlying);
    await guarded("/api/factory/customer-orders");

    now += 31_000;
    visibility = "hidden";
    const stale = await guarded("/api/factory/customer-orders");

    expect(underlying).toHaveBeenCalledTimes(1);
    await expect(stale.json()).resolves.toEqual([{ id: 1 }]);
  });
});
