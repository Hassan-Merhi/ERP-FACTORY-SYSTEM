/**
 * Pure helpers and lookup tables for the WipersReEntry page.
 *
 * Extracted from WipersReEntry.tsx during the Phase 4 god-file split.
 */
import type { FactoryBaleProduct, FactoryCategory } from "@shared/schema";

export function isWipers(product: FactoryBaleProduct, categories: FactoryCategory[]): boolean {
  const cat = categories.find((c) => c.id === product.categoryId);
  const catName = cat?.name?.toLowerCase() || "";
  const prodName = product.name?.toLowerCase() || "";
  return (
    catName.includes("wiper") ||
    prodName.includes("wiper") ||
    catName.includes("garbage") ||
    prodName.includes("garbage")
  );
}

export function isWipersBale(bale: {
  productName?: string | null;
  category?: string | null;
  bale?: { category?: string | null; productName?: string | null };
}): boolean {
  const cat = (bale.bale?.category || bale.category || "").toLowerCase();
  const name = (bale.bale?.productName || bale.productName || "").toLowerCase();
  return cat.includes("wiper") || name.includes("wiper") || cat.includes("garbage") || name.includes("garbage");
}
