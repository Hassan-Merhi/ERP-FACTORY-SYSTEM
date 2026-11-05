import { productMatchesSearch } from "@shared/factoryProductSearch";
import type { FactoryBaleProduct, ProformaSelection, SortDir, SortField } from "./types";
import { applySortProducts } from "./utils";

export interface InventoryProductFilters {
  productSearch: string;
  categoryFilter: string[];
  prodSortField: SortField;
  prodSortDir: SortDir;
  proformaMode: boolean;
  hideZeroAvailable: boolean;
  showZeroStock: boolean;
  showSelectedOnly: boolean;
  selections: { has(productId: number): boolean };
}

/** Search, category, zero-stock and proforma-selection filters, then the chosen sort. */
export function filterInventoryProducts(products: FactoryBaleProduct[], filters: InventoryProductFilters) {
  const {
    productSearch,
    categoryFilter,
    proformaMode,
    hideZeroAvailable,
    showZeroStock,
    showSelectedOnly,
    selections,
  } = filters;
  return applySortProducts(
    products.filter((p) => {
      const matchesSearch = productMatchesSearch(
        { name: p.productName, nameAr: p.productNameAr, articleCode: p.articleCode },
        productSearch
      );
      const matchesCat = categoryFilter.length === 0 || categoryFilter.includes(p.category ?? "Uncategorized");
      const hideZero = proformaMode ? hideZeroAvailable : !showZeroStock;
      if (hideZero && p.baleCount - (p.loadingCount ?? 0) <= 0) return false;
      if (proformaMode && showSelectedOnly) return matchesSearch && matchesCat && selections.has(p.productId);
      return matchesSearch && matchesCat;
    }),
    filters.prodSortField,
    filters.prodSortDir
  );
}

/** Adds every listed product to the proforma selection at its full available quantity, keeping existing picks. */
export function withProductsSelected(
  prev: Map<number, ProformaSelection>,
  products: FactoryBaleProduct[]
): Map<number, ProformaSelection> {
  const next = new Map(prev);
  products.forEach((prod) => {
    if (!next.has(prod.productId)) {
      next.set(prod.productId, {
        productId: prod.productId,
        articleCode: prod.articleCode,
        productName: prod.productName,
        availableBales: prod.baleCount,
        totalWeight: prod.totalWeight,
        selectedQty: prod.baleCount,
        pricePerBale: prod.sellingPrice || "0",
      });
    }
  });
  return next;
}
