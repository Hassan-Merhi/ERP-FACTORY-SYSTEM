import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  previousFetch: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("../../client/src/lib/queryClient", () => ({
  queryClient: { invalidateQueries: harness.invalidateQueries },
}));

function page(items: Array<{ id: number }>, pageNumber: number, totalPages: number, total: number, limit = 100) {
  return new Response(
    JSON.stringify({
      items,
      total,
      page: pageNumber,
      limit,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPreviousPage: pageNumber > 1,
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }
  );
}

describe("factory daybook pagination client", () => {
  let fetchAllDaybookEntries: typeof import("../../client/src/lib/daybookPaginationClient").fetchAllDaybookEntries;

  beforeAll(async () => {
    vi.useFakeTimers();
    history.replaceState({}, "", "/factory/daybook");
    window.__erpDaybookPaginationInstalled = undefined;
    window.fetch = harness.previousFetch;
    ({ fetchAllDaybookEntries } = await import("../../client/src/lib/daybookPaginationClient"));
  });

  beforeEach(() => {
    harness.previousFetch.mockReset();
    harness.invalidateQueries.mockReset();
    history.replaceState({}, "", "/factory/daybook");
  });

  it("loads every server-filtered page only for an explicit full-data action", async () => {
    harness.previousFetch
      .mockResolvedValueOnce(page([{ id: 1 }, { id: 2 }], 1, 2, 3, 250))
      .mockResolvedValueOnce(page([{ id: 3 }], 2, 2, 3, 250));
    const params = new URLSearchParams({ fromDate: "2026-08-01", txType: "SALE" });

    const entries = await fetchAllDaybookEntries(params);

    expect(entries.map((entry) => entry.id)).toEqual([1, 2, 3]);
    expect(harness.previousFetch).toHaveBeenNthCalledWith(1, expect.stringContaining("fullAction=1"), {
      credentials: "include",
    });
    expect(harness.previousFetch).toHaveBeenNthCalledWith(2, expect.stringMatching(/page=2/), {
      credentials: "include",
    });
  });

  it("progressively loads the next page near the bottom and merges it into the existing rows", async () => {
    harness.previousFetch
      .mockResolvedValueOnce(page([{ id: 1 }], 1, 3, 205))
      .mockResolvedValueOnce(page([{ id: 101 }], 2, 3, 205));

    const first = await window.fetch("/api/factory/daybook?txType=SALE");

    expect(await first.json()).toEqual([{ id: 1 }]);
    expect(harness.previousFetch.mock.calls[0][0]).toMatch(/pagination=1/);
    expect(harness.previousFetch.mock.calls[0][0]).toMatch(/page=1/);
    expect(screenText("factory-daybook-progress")).toContain("1 of 205 transactions loaded");
    expect(document.querySelector("[data-testid='factory-daybook-page-next']")).toBeNull();

    Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 1400 });
    Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 700 });
    Object.defineProperty(document.documentElement, "scrollTop", { configurable: true, value: 650 });
    document.documentElement.dispatchEvent(new Event("scroll"));

    expect(harness.invalidateQueries).toHaveBeenCalledOnce();
    expect(screenText("factory-daybook-progress")).toContain("Loading more");

    const second = await window.fetch("/api/factory/daybook?txType=SALE");

    expect(await second.json()).toEqual([{ id: 1 }, { id: 101 }]);
    expect(harness.previousFetch.mock.calls[1][0]).toMatch(/page=2/);
    expect(screenText("factory-daybook-progress")).toContain("2 of 205 transactions loaded");
  });

  it("leaves mutations, explicit exports, deep links, and unrelated routes untouched", async () => {
    harness.previousFetch.mockResolvedValue(new Response(JSON.stringify({ untouched: true }), { status: 200 }));

    await window.fetch("/api/factory/daybook", { method: "POST" });
    await window.fetch("/api/factory/daybook?fullAction=1");
    history.replaceState({}, "", "/factory/daybook?entryId=44");
    await window.fetch("/api/factory/daybook");
    history.replaceState({}, "", "/dashboard");
    await window.fetch("/api/factory/daybook");

    expect(harness.previousFetch.mock.calls.every(([url]) => !String(url).includes("pagination=1"))).toBe(true);
  });
});

function screenText(testId: string): string {
  return document.querySelector(`[data-testid='${testId}']`)?.textContent ?? "";
}
