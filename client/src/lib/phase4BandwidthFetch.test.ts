import { beforeEach, describe, expect, it, vi } from "vitest";

function jsonResponse(payload: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

async function installWith(fetchMock: ReturnType<typeof vi.fn>) {
  delete (window as Window & { __phase4BandwidthFetchInstalled?: boolean }).__phase4BandwidthFetchInstalled;
  window.fetch = fetchMock as typeof window.fetch;
  vi.resetModules();
  await import("./phase4BandwidthFetch");
}

describe("phase4 bandwidth fetch interceptor", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/factory/dashboard");
  });

  it("reconciles all daily scan pages and then requests only rows after the cached max id", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      const page = url.searchParams.get("page");
      const afterId = url.searchParams.get("afterId");
      if (afterId === "3") return jsonResponse([{ id: 4, scan_date: "2026-08-20" }]);
      if (page === "2") return jsonResponse([{ id: 3, scan_date: "2026-08-20" }], { "X-Total-Pages": "2" });
      return jsonResponse(
        [
          { id: 2, scan_date: "2026-08-20" },
          { id: 1, scan_date: "2026-08-20" },
        ],
        { "X-Total-Pages": "2" }
      );
    });
    await installWith(fetchMock);

    const first = await window.fetch("/api/factory/daily-bale-scans?date=2026-08-20");
    expect(await first.json()).toEqual([
      { id: 1, scan_date: "2026-08-20" },
      { id: 2, scan_date: "2026-08-20" },
      { id: 3, scan_date: "2026-08-20" },
    ]);

    const second = await window.fetch("/api/factory/daily-bale-scans?date=2026-08-20");
    expect(await second.json()).toEqual([
      { id: 1, scan_date: "2026-08-20" },
      { id: 2, scan_date: "2026-08-20" },
      { id: 3, scan_date: "2026-08-20" },
      { id: 4, scan_date: "2026-08-20" },
    ]);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes("afterId=3"))).toBe(true);
  });

  it("keeps proforma summaries compact on loading pages and never prefetches detail rows", async () => {
    window.history.replaceState({}, "", "/factory/sales/loading/new");
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), window.location.origin);
      if (url.pathname === "/api/factory/customer-proformas/42") {
        return jsonResponse({ id: 42, lines: [{ articleCode: "BAL-42", qty: 3 }] });
      }
      if (url.pathname === "/api/factory/customer-proformas") {
        return jsonResponse([
          { id: 42, name: "PRO-42", isActive: true, lines: [] },
          { id: 43, name: "PRO-43", isActive: false, lines: [] },
        ]);
      }
      return jsonResponse({});
    });
    await installWith(fetchMock);

    const response = await window.fetch("/api/factory/customer-proformas?profile=summary");
    const payload = await response.json();
    expect(payload[0].lines).toEqual([]);
    expect(payload[1].lines).toEqual([]);

    await window.fetch("/api/factory/customer-proformas?profile=summary");
    const detailCalls = fetchMock.mock.calls.filter(([input]) => /customer-proformas\/42(?:$|\?)/.test(String(input)));
    expect(detailCalls).toHaveLength(0);
  });

  it("passes unrelated requests through and invalidates proforma caches after a write", async () => {
    window.history.replaceState({}, "", "/factory/sales/loading/new");
    let summaryVersion = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), window.location.origin);
      if ((init?.method || "GET").toUpperCase() === "POST") return jsonResponse({ ok: true });
      if (url.pathname === "/api/factory/customer-proformas") {
        summaryVersion += 1;
        return jsonResponse([{ id: 50, isActive: false, version: summaryVersion }]);
      }
      return jsonResponse({ path: url.pathname });
    });
    await installWith(fetchMock);

    const passthrough = await window.fetch("/health");
    expect(await passthrough.json()).toEqual({ path: "/health" });

    const first = await window.fetch("/api/factory/customer-proformas?profile=summary");
    expect((await first.json())[0].version).toBe(1);
    const cached = await window.fetch("/api/factory/customer-proformas?profile=summary");
    expect((await cached.json())[0].version).toBe(1);

    await window.fetch("/api/factory/customer-proformas", { method: "POST", body: "{}" });
    const refreshed = await window.fetch("/api/factory/customer-proformas?profile=summary");
    expect((await refreshed.json())[0].version).toBe(2);
  });
});
