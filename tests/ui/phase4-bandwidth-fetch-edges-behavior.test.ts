/**
 * Edges of the Phase 4 bandwidth interceptor beyond its unit tests: a failed
 * daily-scan page is handed back untouched and never cached, deletes and new
 * scans update the cached day in place, a full reconcile runs again after ten
 * minutes, failed proforma summaries are not cached, bypassed and non-API
 * requests pass straight through, and the patch installs once.
 */
type Patched = Window & { __phase4BandwidthFetchInstalled?: boolean };

const json = (payload: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(payload), {
    status: 200,
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers as Record<string, string>) },
  });

let inner: ReturnType<typeof vi.fn>;
const realFetch = window.fetch;

async function install(handler: (url: URL, init?: RequestInit) => Response | Promise<Response>) {
  inner = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(new URL(String(input), window.location.origin), init)
  );
  delete (window as Patched).__phase4BandwidthFetchInstalled;
  window.fetch = inner as unknown as typeof fetch;
  vi.resetModules();
  return import("@/lib/phase4BandwidthFetch");
}

const DAY = "/api/factory/daily-bale-scans?date=2026-10-01";
const ids = async (response: Response) => ((await response.json()) as Array<{ id: number }>).map((row) => row.id);
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  window.fetch = realFetch;
  vi.useRealTimers();
});

describe("daily scans", () => {
  it("hands back a failed page untouched and does not cache it", async () => {
    let fail = true;
    await install(() => (fail ? json({ message: "down" }, { status: 503 }) : json([{ id: 1 }])));

    const failed = await window.fetch(DAY);
    expect(failed.status).toBe(503);
    fail = false;
    expect(await ids(await window.fetch(DAY))).toEqual([1]);
    expect(inner.mock.calls.at(-1)![0]).not.toContain("afterId");
  });

  it("treats an unreadable page as empty", async () => {
    await install(() => new Response("not json", { status: 200 }));

    expect(await (await window.fetch(DAY)).json()).toEqual([]);
  });

  it("hands back a failed delta untouched", async () => {
    let calls = 0;
    await install(() => (++calls === 1 ? json([{ id: 5 }]) : json({ message: "down" }, { status: 500 })));
    await window.fetch(DAY);

    const failed = await window.fetch(DAY);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ message: "down" });
    expect(inner.mock.calls.at(-1)![0]).toContain("afterId=5");
  });

  it("removes a deleted scan and adds a new one to the cached day", async () => {
    await install((url, init) => {
      if (init?.method === "DELETE") return json({});
      if (init?.method === "POST") return json({ id: 9, scan_date: "2026-10-01" });
      return json(url.searchParams.has("afterId") ? [] : [{ id: 1 }, { id: 2 }]);
    });
    await window.fetch(DAY);
    await window.fetch("/api/factory/daily-bale-scans?date=2026-10-02");

    await window.fetch("/api/factory/daily-bale-scans/2", { method: "DELETE" });
    await window.fetch("/api/factory/daily-bale-scans", { method: "POST", body: "{}" });
    await flush();

    expect(await ids(await window.fetch(DAY))).toEqual([1, 9]);
    expect(await ids(await window.fetch("/api/factory/daily-bale-scans?date=2026-10-02"))).toEqual([1]);
  });

  it("ignores failed writes, deletes without an id and new scans without a date", async () => {
    let postBody: unknown = { id: 9 };
    let reads = 0;
    await install((url, init) => {
      if (init?.method === "DELETE") return json({}, { status: url.pathname.endsWith("/1") ? 409 : 200 });
      if (init?.method === "POST") return json(postBody);
      // Only the first read returns the row, so a wrongly dropped row stays dropped.
      return json(++reads === 1 ? [{ id: 1 }] : []);
    });
    await window.fetch(DAY);

    await window.fetch("/api/factory/daily-bale-scans/1", { method: "DELETE" });
    await window.fetch("/api/factory/daily-bale-scans/bulk", { method: "DELETE" });
    await window.fetch("/api/factory/daily-bale-scans", { method: "POST" });
    postBody = null;
    await window.fetch("/api/factory/daily-bale-scans", { method: "POST" });
    await flush();

    expect(await ids(await window.fetch(DAY))).toEqual([1]);
  });

  it("runs a full reconcile again after ten minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    await install(() => json([{ id: 1 }]));
    await window.fetch(DAY);

    vi.setSystemTime(Date.now() + 10 * 60_000);
    await window.fetch(DAY);

    expect(inner.mock.calls.at(-1)![0]).not.toContain("afterId");
  });
});

describe("pass-through and proforma summaries", () => {
  it("does not cache a failed proforma summary", async () => {
    let status = 502;
    await install(() => json([], { status }));
    const summary = "/api/factory/customer-proformas?profile=summary";

    expect((await window.fetch(summary)).status).toBe(502);
    status = 200;
    expect((await window.fetch(summary)).status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("passes bypassed, non-API and unrelated requests straight through", async () => {
    await install(() => json([]));
    const bypassed = { headers: { "x-phase4-bandwidth-bypass": "1" } };

    await window.fetch(DAY, bypassed);
    await window.fetch("/assets/app.js");
    await window.fetch("/api/factory/daily-bale-scans");

    expect(inner.mock.calls.map(([url]) => String(url))).toEqual([
      DAY,
      "/assets/app.js",
      "/api/factory/daily-bale-scans",
    ]);
  });

  it("installs only once", async () => {
    const module = await install(() => json([]));
    const patched = window.fetch;

    module.installPhase4BandwidthFetch();

    expect(window.fetch).toBe(patched);
  });
});
