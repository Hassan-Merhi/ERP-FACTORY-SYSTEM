// Extracted from ./BaleProductsBilingual.tsx

export type TranslationFilter = "all" | "complete" | "missing-product" | "missing-category";

export interface BilingualProduct {
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  code?: string | null;
  articleCode?: string | null;
  categoryId?: number | null;
  categoryName?: string | null;
  categoryNameAr?: string | null;
  categoryNameFr?: string | null;
}

function matchesTranslationFilter(product: BilingualProduct, filter: TranslationFilter): boolean {
  const hasProduct = Boolean(product.nameAr?.trim());
  const hasCategory = !product.categoryId || Boolean(product.categoryNameAr?.trim());
  if (filter === "complete") return hasProduct && hasCategory;
  if (filter === "missing-product") return !hasProduct;
  if (filter === "missing-category") return Boolean(product.categoryId) && !hasCategory;
  return true;
}

function matchesCatalogSearch(product: BilingualProduct, search: string): boolean {
  const needle = search.trim().toLocaleLowerCase();
  if (!needle) return true;
  return [
    product.name,
    product.nameAr,
    product.nameFr,
    product.code,
    product.articleCode,
    product.categoryName,
    product.categoryNameAr,
    product.categoryNameFr,
  ].some((value) => value?.toLocaleLowerCase().includes(needle));
}

export function filterCatalog(
  products: BilingualProduct[],
  search: string,
  translationFilter: TranslationFilter
): BilingualProduct[] {
  if (!search && translationFilter === "all") return products;
  return products.filter(
    (product) => matchesCatalogSearch(product, search) && matchesTranslationFilter(product, translationFilter)
  );
}
