import type { PagedStockItemsResponse, StockItem } from "./types";

export type StockItemsExportFilters = {
  search: string;
  stockGroupId: number | null;
  gradeId: number | null;
  categoryId: number | "none" | null;
};

// The first /api/stock-items paginated route accepts at most 250 items.
const EXPORT_PAGE_SIZE = 250;

/**
 * Export every matching stock item, independent of the visible page.
 * Honor the *effective* page size reported by the server, even if a route
 * applies a smaller cap than requested. Never download a partial workbook.
 */
export async function loadStockItemsForExport(
  filters: StockItemsExportFilters,
  fetcher: typeof fetch = fetch
): Promise<StockItem[]> {
  const params = new URLSearchParams({ pageSize: String(EXPORT_PAGE_SIZE) });
  if (filters.search.trim()) params.set("search", filters.search.trim());
  if (filters.stockGroupId !== null) params.set("stockGroupId", String(filters.stockGroupId));
  if (filters.gradeId !== null) params.set("gradeId", String(filters.gradeId));
  if (filters.categoryId !== null) params.set("categoryId", String(filters.categoryId));

  const items: StockItem[] = [];
  let expectedTotal = 0;
  let expectedPageSize = 0;
  let expectedPages = 1;

  for (let page = 1; page <= expectedPages; page++) {
    params.set("page", String(page));
    const response = await fetcher(`/api/stock-items?${params}`, { credentials: "include" });
    if (!response.ok) throw new Error("Failed to load stock items for export");

    const batch = (await response.json()) as PagedStockItemsResponse;
    if (
      !Array.isArray(batch.data) ||
      !Number.isSafeInteger(batch.total) ||
      batch.total < 0 ||
      batch.page !== page ||
      !Number.isSafeInteger(batch.pageSize) ||
      batch.pageSize < 1 ||
      batch.pageSize > EXPORT_PAGE_SIZE ||
      !Number.isSafeInteger(batch.totalPages)
    ) {
      throw new Error("Invalid stock items export response");
    }

    if (page === 1) {
      expectedTotal = batch.total;
      expectedPageSize = batch.pageSize;
      expectedPages = Math.max(1, Math.ceil(expectedTotal / expectedPageSize));
    }
    if (
      batch.total !== expectedTotal ||
      batch.pageSize !== expectedPageSize ||
      batch.totalPages !== Math.ceil(expectedTotal / expectedPageSize)
    ) {
      throw new Error("Stock items changed during export. Please try again");
    }
    items.push(...batch.data);
  }

  if (items.length !== expectedTotal || new Set(items.map((item) => item.id)).size !== expectedTotal) {
    throw new Error("Stock items export was incomplete. Please try again");
  }
  return items;
}
