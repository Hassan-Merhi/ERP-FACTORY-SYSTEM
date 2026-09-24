/**
 * Search matching for factory bale products across English, Arabic and French names.
 *
 * Arabic needs more than `toLowerCase()`: the same word is commonly written with
 * different alef/yeh/teh-marbuta forms, with or without diacritics, and operators
 * type both ASCII and Arabic-Indic digits. Normalising both sides of the comparison
 * keeps a search for "كيس كريمي" matching a stored "كِيس كريمى".
 */

import { normalizeSearchText } from "./searchNormalization";

export const normalizeProductSearchText = normalizeSearchText;

export interface SearchableFactoryProduct {
  name?: string | null;
  nameAr?: string | null;
  nameFr?: string | null;
  articleCode?: string | null;
  code?: string | null;
}

/**
 * True when the product matches the term in any supported language, or by code.
 * An empty term matches everything so callers can pass raw input straight through.
 */
export function productMatchesSearch(product: SearchableFactoryProduct, term: string): boolean {
  const needle = normalizeProductSearchText(term);
  if (!needle) return true;
  return [product.articleCode, product.code, product.name, product.nameAr, product.nameFr].some((field) =>
    normalizeProductSearchText(field).includes(needle)
  );
}
