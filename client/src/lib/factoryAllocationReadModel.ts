import type { V5AllocationRow } from "./v5AllocationPaginationClient";

/**
 * Shared V5 proforma editor read model.
 * Do not recompute stock or reservation quantities here. The server's V5
 * stockAvailable, totalLoaded, expectedToLoad and freeToPromise are canonical.
 * This is a projection only and performs no write or floating-point rounding.
 */
export type FactoryProformaAllocationArticle = Pick<
  V5AllocationRow,
  "articleCode" | "productName" | "categoryName" |
  "stockAvailable" | "totalLoaded" | "expectedToLoad" | "freeToPromise"
>;

export function toFactoryProformaAllocationArticles(
  rows: readonly V5AllocationRow[],
): FactoryProformaAllocationArticle[] {
  return rows
    .map((row) => ({
      articleCode: row.articleCode,
      productName: row.productName,
      categoryName: row.categoryName,
      stockAvailable: row.stockAvailable,
      totalLoaded: row.totalLoaded,
      expectedToLoad: row.expectedToLoad,
      freeToPromise: row.freeToPromise,
    }))
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

/** Prefixes intentionally retain URL-first keys for legacy invalidations. */
export const FACTORY_V5_ALLOCATION_BASE = "/api/factory/v5/stock-allocation" as const;
export const FACTORY_V5_CREATE_SNAPSHOT = "/api/factory/v5/stock-allocation/all-for-create" as const;
export const FACTORY_V5_EDIT_SNAPSHOT = "/api/factory/v5/stock-allocation/all-for-edit" as const;
