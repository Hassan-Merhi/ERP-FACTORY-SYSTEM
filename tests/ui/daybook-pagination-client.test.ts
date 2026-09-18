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

  it("returns an empty list and hides the indicator for an empty result", async () => {
    harness.previousFetch.mockResolvedValueOnce(page([], 1, 0, 0));

    const response = await window.fetch("/api/factory/daybook?txType=EMPTY");

    expect(await response.json()).toEqual([]);
    expect(progressDisplay()).toBe("none");
  });

  it("treats an envelope without counts as one loaded page rather than an empty result", async () => {
    harness.previousFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [{ id: 7 }, { id: 8 }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

    const response = await window.fetch("/api/factory/daybook?txType=NOMETA");

    // The rows still reach the table as an array, and the missing page count is
    // read as "no known next page" instead of "the server reported zero pages".
    expect(await response.json()).toEqual([{ id: 7 }, { id: 8 }]);
    expect(progressDisplay()).toBe("none");

    scrollToBottom();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
  });

  it("stops asking for more pages once the last page is loaded", async () => {
    harness.previousFetch
      .mockResolvedValueOnce(page([{ id: 11 }], 1, 2, 2))
      .mockResolvedValueOnce(page([{ id: 12 }], 2, 2, 2));

    await window.fetch("/api/factory/daybook?txType=LAST");
    scrollToBottom();
    expect(harness.invalidateQueries).toHaveBeenCalledOnce();

    const last = await window.fetch("/api/factory/daybook?txType=LAST");
    expect(await last.json()).toEqual([{ id: 11 }, { id: 12 }]);
    expect(progressDisplay()).toBe("none");

    harness.invalidateQueries.mockReset();
    scrollToBottom();
    expect(harness.invalidateQueries).not.toHaveBeenCalled();
    expect(harness.previousFetch).toHaveBeenCalledTimes(2);
  });

  it("answers with the merged rows, not the raw envelope, when the requested page vanished", async () => {
    harness.previousFetch
      .mockResolvedValueOnce(page([{ id: 21 }], 1, 3, 205))
      // The filtered set shrank to a single page while page 2 was in flight.
      .mockResolvedValueOnce(page([], 2, 1, 1));

    await window.fetch("/api/factory/daybook?txType=SHRANK");
    scrollToBottom();

    const stale = await window.fetch("/api/factory/daybook?txType=SHRANK");

    // The daybook reads this body as DaybookEntry[]; an envelope object here
    // would make it call .length and .find on a plain object.
    expect(await stale.json()).toEqual([{ id: 21 }]);
    await Promise.resolve();
    expect(harness.invalidateQueries).toHaveBeenCalledTimes(2);
  });

  it("starts a fresh page cache when the active company changes mid-load", async () => {
    localStorage.setItem("selectedCompanyId", "1");
    harness.previousFetch
      .mockResolvedValueOnce(page([{ id: 31 }], 1, 3, 205))
      .mockResolvedValueOnce(page([{ id: 91 }], 1, 1, 1));

    await window.fetch("/api/factory/daybook?txType=SCOPE");
    // Queue page 2 of company 1, then switch before it is requested. The URL is
    // byte-identical across companies because the company travels in the
    // session cookie.
    scrollToBottom();
    localStorage.setItem("selectedCompanyId", "2");

    const switched = await window.fetch("/api/factory/daybook?txType=SCOPE");

    // Company 2 must start at page 1 with none of company 1's rows merged in.
    expect(harness.previousFetch.mock.calls[1][0]).toMatch(/page=1/);
    expect(await switched.json()).toEqual([{ id: 91 }]);
    localStorage.removeItem("selectedCompanyId");
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

function progressDisplay(): string {
  const root = document.querySelector<HTMLElement>("[data-testid='factory-daybook-progress']");
  return root?.style.display ?? "none";
}

function scrollToBottom(): void {
  Object.defineProperty(document.documentElement, "scrollHeight", { configurable: true, value: 1400 });
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 700 });
  Object.defineProperty(document.documentElement, "scrollTop", { configurable: true, value: 650 });
  document.documentElement.dispatchEvent(new Event("scroll"));
}
