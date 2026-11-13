import type { PagedStockItemsResponse, StockItem } from "./types";

export type StockItemsExportFilters = {
  search: string;
  stockGroupId: number | null;
  gradeId: number | null;
  categoryId: number | "none" | null;
};

const EXPORT_PAGE_SIZE = 500;

/**
 * Export the full current filter result, not the currently displayed page.
 * The endpoint caps pageSize at 500, so walk every page and reject incomplete
 * responses rather than silently generating a truncated workbook.
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
      batch.pageSize !== EXPORT_PAGE_SIZE
    ) {
      throw new Error("Invalid stock items export response");
    }

    if (page === 1) {
      expectedTotal = batch.total;
      expectedPages = Math.max(1, Math.ceil(expectedTotal / EXPORT_PAGE_SIZE));
    }
    if (batch.total !== expectedTotal || batch.totalPages !== Math.ceil(expectedTotal / EXPORT_PAGE_SIZE)) {
      throw new Error("Stock items changed during export. Please try again");
    }
    items.push(...batch.data);
  }

  if (items.length !== expectedTotal || new Set(items.map((item) => item.id)).size !== expectedTotal) {
    throw new Error("Stock items export was incomplete. Please try again");
  }
  return items;
}
