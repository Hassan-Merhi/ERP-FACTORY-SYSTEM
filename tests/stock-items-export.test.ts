import { describe, expect, it, vi } from "vitest";
import { loadStockItemsForExport, type StockItemsExportFilters } from "../client/src/pages/stockitems/stockItemsExport";

const noFilters: StockItemsExportFilters = { search: "", stockGroupId: null, gradeId: null, categoryId: null };

function pageResponse(page: number, total: number, data: Array<{ id: number }>, pageSize = 250) {
  return {
    ok: true,
    json: async () => ({ page, pageSize, total, totalPages: Math.ceil(total / pageSize), data }),
  } as Response;
}

describe("Stock Items Excel export pagination", () => {
  it("loads every item across pages with the live 250-item API cap", async () => {
    const ids = Array.from({ length: 1120 }, (_, index) => ({ id: index + 1 }));
    const fetcher = vi.fn(async (url: string, options: RequestInit) => {
      const params = new URL(url, "https://example.test").searchParams;
      const page = Number(params.get("page"));
      expect(params.get("pageSize")).toBe("250");
      expect(options.credentials).toBe("include");
      return pageResponse(page, ids.length, ids.slice((page - 1) * 250, page * 250));
    });

    const result = await loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch);
    expect(result).toHaveLength(1120);
    expect(result.map((item) => item.id)).toEqual(ids.map((item) => item.id));
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it("passes every active filter to every requested page", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const params = new URL(url, "https://example.test").searchParams;
      expect(params.get("search")).toBe("bath");
      expect(params.get("stockGroupId")).toBe("5");
      expect(params.get("gradeId")).toBe("6");
      expect(params.get("categoryId")).toBe("none");
      const page = Number(params.get("page"));
      const start = (page - 1) * 250;
      const rows = Array.from({ length: Math.min(250, 501 - start) }, (_, index) => ({ id: start + index + 1 }));
      return pageResponse(page, 501, rows);
    });

    const result = await loadStockItemsForExport(
      { search: "  bath  ", stockGroupId: 5, gradeId: 6, categoryId: "none" },
      fetcher as unknown as typeof fetch
    );
    expect(result).toHaveLength(501);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("accepts a smaller effective page size returned by a server route", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
      const start = (page - 1) * 125;
      const rows = Array.from({ length: Math.min(125, 350 - start) }, (_, index) => ({ id: start + index + 1 }));
      return pageResponse(page, 350, rows, 125);
    });
    const result = await loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch);
    expect(result).toHaveLength(350);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("returns no rows when the filters have no matches", async () => {
    const fetcher = vi.fn(async () => pageResponse(1, 0, []));
    expect(await loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch)).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects missing rows rather than downloading a partial workbook", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
      const start = (page - 1) * 250;
      if (page === 3) return pageResponse(page, 501, []);
      const rows = Array.from({ length: 250 }, (_, index) => ({ id: start + index + 1 }));
      return pageResponse(page, 501, rows);
    });
    await expect(loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch)).rejects.toThrow("incomplete");
  });

  it("rejects duplicates across page boundaries", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
      const start = (page - 1) * 250;
      if (page === 3) return pageResponse(page, 501, [{ id: 500 }]);
      const rows = Array.from({ length: 250 }, (_, index) => ({ id: start + index + 1 }));
      return pageResponse(page, 501, rows);
    });
    await expect(loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch)).rejects.toThrow("incomplete");
  });

  it("fails safely if a page request fails", async () => {
    const fetcher = vi.fn(async (url: string) => {
      const page = Number(new URL(url, "https://example.test").searchParams.get("page"));
      return page === 1
        ? pageResponse(
            1,
            501,
            Array.from({ length: 250 }, (_, index) => ({ id: index + 1 }))
          )
        : ({ ok: false, status: 500 } as Response);
    });
    await expect(loadStockItemsForExport(noFilters, fetcher as unknown as typeof fetch)).rejects.toThrow(
      "Failed to load stock items"
    );
  });
});
