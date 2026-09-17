/**
 * Stock-allocation progressive browsing: start small, append on scroll, export everything.
 *
 * The on-screen table intentionally keeps its first request at 50 rows so the
 * initial Render payload stays bounded. Additional pages are fetched only when
 * the user approaches the bottom and are merged into the existing response.
 * Explicit business actions still use fetchAllV5AllocationData because export
 * and proforma workflows require a complete snapshot immediately.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ENDPOINT = "/api/factory/v5/stock-allocation";

let underlyingFetch: ReturnType<typeof vi.fn>;
let fetchAllV5AllocationData: (params?: URLSearchParams) => Promise<{ rows: unknown[]; [key: string]: unknown }>;

function sentUrl(call: unknown[]): URL {
  const input = call[0];
  const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  return new URL(raw, "http://localhost");
}

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    statusText: ok ? "OK" : "Error",
    headers: new Headers({ "Content-Type": "application/json" }),
    clone() {
      return this;
    },
    json: async () => body,
  } as unknown as Response;
}

function allocationPage(overrides: Record<string, unknown> = {}) {
  return {
    rows: [{ articleCode: "A-1" }],
    totals: {},
    productNames: { "A-1": "Article One" },
    total: 1,
    page: 1,
    limit: 50,
    totalPages: 1,
    ...overrides,
  };
}

beforeAll(async () => {
  window.history.replaceState({}, "", "/factory/stock-allocation-v5");
  underlyingFetch = vi.fn(async () => jsonResponse(allocationPage()));
  window.fetch = underlyingFetch as unknown as typeof window.fetch;

  const module = await import("../../client/src/lib/v5AllocationPaginationClient");
  fetchAllV5AllocationData = module.fetchAllV5AllocationData as typeof fetchAllV5AllocationData;
});

beforeEach(() => {
  underlyingFetch.mockClear();
  underlyingFetch.mockImplementation(async () => jsonResponse(allocationPage()));
  window.history.replaceState({}, "", "/factory/stock-allocation-v5");
});

afterEach(() => {
  document.querySelector("#erp-v5-allocation-progress")?.remove();
});

describe("v5 allocation full-data fetch", () => {
  it("walks every server page and returns the rows joined", async () => {
    underlyingFetch.mockImplementation(async (input: unknown) => {
      const page = sentUrl([input]).searchParams.get("page");
      return jsonResponse(
        allocationPage({
          rows: [{ articleCode: `A-${page}` }, { articleCode: `B-${page}` }],
          productNames: { [`A-${page}`]: `Article ${page}` },
          totalPages: 3,
          page: Number(page),
        })
      );
    });

    const result = await fetchAllV5AllocationData(new URLSearchParams({ companyId: "1" }));

    expect(result.rows).toHaveLength(6);
    expect(underlyingFetch).toHaveBeenCalledTimes(3);
    expect(Object.keys(result.productNames as Record<string, string>)).toHaveLength(3);
  });

  it("asks for the full-action limit, not the on-screen one", async () => {
    await fetchAllV5AllocationData(new URLSearchParams({ companyId: "1" }));

    const url = sentUrl(underlyingFetch.mock.calls[0]);
    expect(url.searchParams.get("fullAction")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("250");
    expect(url.searchParams.get("companyId")).toBe("1");
  });

  it("reports the joined result as a single complete page", async () => {
    const result = await fetchAllV5AllocationData();

    expect(result.hasNextPage).toBe(false);
    expect(result.hasPreviousPage).toBe(false);
    expect(result.page).toBe(1);
  });

  it("throws rather than returning the pages it managed to collect", async () => {
    underlyingFetch.mockImplementation(async (input: unknown) => {
      const page = Number(sentUrl([input]).searchParams.get("page"));
      if (page === 2) return jsonResponse({ message: "Allocation page unavailable" }, false, 503);
      return jsonResponse(allocationPage({ rows: [{ articleCode: `A-${page}` }], totalPages: 3, page }));
    });

    await expect(fetchAllV5AllocationData()).rejects.toThrow("Allocation page unavailable");
  });

  it("throws when the very first page fails", async () => {
    underlyingFetch.mockImplementation(async () => jsonResponse({}, false, 500));

    await expect(fetchAllV5AllocationData()).rejects.toThrow(/complete stock allocation/i);
  });
});

describe("v5 allocation on-screen interception", () => {
  it("keeps the initial table payload at 50 rows", async () => {
    await window.fetch(`${ENDPOINT}?companyId=1&filter=initial`);

    const url = sentUrl(underlyingFetch.mock.calls[0]);
    expect(url.searchParams.get("pagination")).toBe("1");
    expect(url.searchParams.get("page")).toBe("1");
    expect(url.searchParams.get("limit")).toBe("50");
  });

  it("loads the next page near the bottom and merges it with already-loaded rows", async () => {
    underlyingFetch.mockImplementation(async (input: unknown) => {
      const page = Number(sentUrl([input]).searchParams.get("page") || "1");
      return jsonResponse(
        allocationPage({
          rows: [{ articleCode: page === 1 ? "A-1" : "B-1" }],
          productNames: page === 1 ? { "A-1": "Article One" } : { "B-1": "Article Two" },
          total: 2,
          page,
          totalPages: 2,
        })
      );
    });

    const first = await window.fetch(`${ENDPOINT}?companyId=1&filter=progressive`);
    const firstBody = (await first.json()) as { rows: Array<{ articleCode: string }> };
    expect(firstBody.rows.map((row) => row.articleCode)).toEqual(["A-1"]);

    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 700 });
    Object.defineProperty(document.documentElement, "scrollTop", { configurable: true, value: 650 });
    document.documentElement.dispatchEvent(new Event("scroll"));

    const second = await window.fetch(`${ENDPOINT}?companyId=1&filter=progressive`);
    const secondBody = (await second.json()) as { rows: Array<{ articleCode: string }> };

    expect(sentUrl(underlyingFetch.mock.calls[1]).searchParams.get("page")).toBe("2");
    expect(secondBody.rows.map((row) => row.articleCode)).toEqual(["A-1", "B-1"]);
    expect(document.querySelector("[data-testid='v5-allocation-page-next']")).toBeNull();
  });

  it("leaves an explicit full-action request alone", async () => {
    await window.fetch(`${ENDPOINT}?companyId=1&fullAction=1&limit=250`);

    expect(sentUrl(underlyingFetch.mock.calls[0]).searchParams.get("limit")).toBe("250");
  });

  it("leaves other endpoints alone", async () => {
    await window.fetch("/api/factory/v5/something-else?companyId=1");

    expect(sentUrl(underlyingFetch.mock.calls[0]).searchParams.has("pagination")).toBe(false);
  });

  it("lands on a real page when the server reports fewer than requested", async () => {
    underlyingFetch.mockImplementation(async () => jsonResponse(allocationPage({ page: 7, totalPages: 2, total: 60 })));
    await window.fetch(`${ENDPOINT}?companyId=1&filter=clamp`);

    underlyingFetch.mockImplementation(async () => jsonResponse(allocationPage({ page: 2, totalPages: 2, total: 60 })));
    await window.fetch(`${ENDPOINT}?companyId=1&filter=clamp`);

    expect(sentUrl(underlyingFetch.mock.calls[1]).searchParams.get("page")).toBe("2");
  });

  it("passes a failed response through unread", async () => {
    underlyingFetch.mockImplementation(async () => jsonResponse({}, false, 502));

    const response = await window.fetch(`${ENDPOINT}?companyId=1&filter=error`);
    expect(response.status).toBe(502);
  });
});
