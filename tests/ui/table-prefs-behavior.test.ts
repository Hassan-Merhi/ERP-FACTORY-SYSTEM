/**
 * useTablePrefs keeps a table's presentation choices (sort, page size,
 * columns, density) in localStorage, per page and per company. Stored data is
 * user-controlled, so everything read back is validated, and older documents
 * are migrated or ignored rather than trusted.
 */
import { act, renderHook } from "@testing-library/react";
import { readTablePrefs, useTablePrefs } from "@/hooks/use-table-prefs";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("useTablePrefs", () => {
  it("persists changes under a company-scoped key and reads them back", () => {
    const { result, unmount } = renderHook(() => useTablePrefs("vouchers", { companyId: 7 }));

    act(() => result.current.setPrefs({ sortKey: "date", sortDir: "desc", pageSize: 50, density: "compact" }));

    expect(result.current.prefs).toEqual({ sortKey: "date", sortDir: "desc", pageSize: 50, density: "compact" });
    expect(JSON.parse(localStorage.getItem("table-prefs:company:7:vouchers")!)).toEqual({
      version: 2,
      prefs: { sortKey: "date", sortDir: "desc", pageSize: 50, density: "compact" },
    });
    unmount();

    const reopened = renderHook(() => useTablePrefs("vouchers", { companyId: 7 }));
    expect(reopened.result.current.prefs.pageSize).toBe(50);
  });

  it("keeps companies and global tables apart", () => {
    const one = renderHook(() => useTablePrefs("stock", { companyId: 1 }));
    act(() => one.result.current.setPrefs({ pageSize: 100 }));

    expect(renderHook(() => useTablePrefs("stock", { companyId: 2 })).result.current.prefs).toEqual({});
    expect(renderHook(() => useTablePrefs("stock")).result.current.prefs).toEqual({});
    expect(localStorage.getItem("table-prefs:company:1:stock")).not.toBeNull();
  });

  it("switches to the new company's preferences when the company changes", () => {
    localStorage.setItem("table-prefs:company:2:stock", JSON.stringify({ version: 2, prefs: { pageSize: 25 } }));
    const { result, rerender } = renderHook(({ companyId }) => useTablePrefs("stock", { companyId }), {
      initialProps: { companyId: 1 },
    });
    act(() => result.current.setPrefs({ pageSize: 100 }));

    rerender({ companyId: 2 });

    expect(result.current.prefs.pageSize).toBe(25);
  });

  it("merges partial updates and accepts updater functions", () => {
    const { result } = renderHook(() => useTablePrefs("p"));

    act(() => result.current.setPrefs({ sortKey: "name" }));
    act(() => result.current.setPrefs({ pageSize: 20 }));
    act(() => result.current.setPrefs((previous) => ({ ...previous, sortDir: "asc" })));

    expect(result.current.prefs).toEqual({ sortKey: "name", pageSize: 20, sortDir: "asc" });
  });

  it("validates what it is given before storing it", () => {
    const { result } = renderHook(() => useTablePrefs("p"));

    act(() =>
      result.current.setPrefs({
        sortDir: "sideways" as never,
        pageSize: 9999,
        density: "huge" as never,
        columns: { amount: false, notes: "yes" as never },
        filters: ["not", "an", "object"] as never,
      })
    );

    expect(result.current.prefs).toEqual({ columns: { amount: false } });
  });

  it("clears the stored preferences", () => {
    const { result } = renderHook(() => useTablePrefs("p"));
    act(() => result.current.setPrefs({ pageSize: 10 }));

    act(() => result.current.clearPrefs());

    expect(result.current.prefs).toEqual({});
    expect(localStorage.getItem("table-prefs:global:p")).toBeNull();
  });

  it("keeps working when storage rejects writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Quota exceeded", "QuotaExceededError");
    });
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { result } = renderHook(() => useTablePrefs("p"));

    act(() => result.current.setPrefs({ pageSize: 10 }));
    expect(result.current.prefs.pageSize).toBe(10);

    act(() => result.current.clearPrefs());
    expect(result.current.prefs).toEqual({});
  });

  it("offers the standard page sizes", () => {
    expect(renderHook(() => useTablePrefs("p")).result.current.defaultPageSizes).toEqual([10, 20, 25, 50, 100]);
  });
});

describe("readTablePrefs", () => {
  it.each([
    ["nothing stored", null, {}],
    ["unreadable JSON", "{oops", {}],
    ["a document from another version", JSON.stringify({ version: 1, prefs: { pageSize: 10 } }), {}],
    ["a pre-versioned document", JSON.stringify({ pageSize: 20, sortDir: "asc" }), { pageSize: 20, sortDir: "asc" }],
    ["a stored array", JSON.stringify([1, 2]), {}],
    ["a fractional page size", JSON.stringify({ version: 2, prefs: { pageSize: 2.5 } }), {}],
    [
      "filters",
      JSON.stringify({ version: 2, prefs: { filters: { status: "open" } } }),
      { filters: { status: "open" } },
    ],
  ])("reads %s safely", (_label, stored, expected) => {
    if (stored !== null) localStorage.setItem("k", stored);
    expect(readTablePrefs("k")).toEqual(expected);
  });
});
