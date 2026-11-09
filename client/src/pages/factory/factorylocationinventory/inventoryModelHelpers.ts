/**
 * Pure helpers for the FactoryLocationInventory model hook.
 *
 * Extracted from FactoryLocationInventoryModel.tsx during the god-file split.
 * Read-only: no business writes.
 */
import type { CategoryGroup, FactoryBaleProduct, FactoryProformaLine, ProformaSelection } from "./types";

/** Default proforma selection for a product: every bale at its selling price. */
export function toProformaSelection(prod: FactoryBaleProduct): ProformaSelection {
  return {
    productId: prod.productId,
    articleCode: prod.articleCode,
    productName: prod.productName,
    availableBales: prod.baleCount,
    totalWeight: prod.totalWeight,
    selectedQty: prod.baleCount,
    pricePerBale: prod.sellingPrice || "0",
  };
}

/** Group inventory rows by category, accumulating bale, weight, cost and sell-value totals. */
export function groupInventoryByCategory(items: FactoryBaleProduct[]): CategoryGroup[] {
  return items.reduce((groups, item) => {
    const catId = item.categoryId || 0;
    let group = groups.find((g) => (g.categoryId || 0) === catId);
    if (!group) {
      group = {
        categoryId: item.categoryId,
        categoryName: item.category || "Uncategorized",
        baleCount: 0,
        totalWeight: 0,
        totalCost: 0,
        totalSellValue: 0,
        productCount: 0,
        products: [],
      };
      groups.push(group);
    }
    group.baleCount += item.baleCount;
    group.totalWeight += item.totalWeight;
    group.totalCost += item.totalCost;
    group.totalSellValue += (item.baleCount - (item.loadingCount ?? 0)) * parseFloat(item.sellingPrice || "0");
    group.productCount += 1;
    group.products.push(item);
    return groups;
  }, [] as CategoryGroup[]);
}

/**
 * Rebuild proforma selections from an existing proforma's lines. Lines whose
 * article code is not in this location's inventory get a negative synthetic id.
 */
export function buildEditProformaSelections(
  inventoryData: FactoryBaleProduct[],
  editProformaLines: FactoryProformaLine[]
): Map<number, ProformaSelection> {
  const productByArticleCode = new Map<string, FactoryBaleProduct>();
  inventoryData.forEach((product) => {
    productByArticleCode.set((product.articleCode || "").toLowerCase(), product);
  });
  const newSelections = new Map<number, ProformaSelection>();
  editProformaLines.forEach((line, index) => {
    const prod = productByArticleCode.get((line.articleCode || "").toLowerCase());
    if (prod) {
      newSelections.set(prod.productId, {
        productId: prod.productId,
        articleCode: prod.articleCode,
        productName: prod.productName,
        availableBales: prod.baleCount,
        totalWeight: prod.totalWeight,
        selectedQty: line.quantity,
        pricePerBale: line.pricePerBale,
      });
    } else {
      const syntheticId = -(index + 1);
      newSelections.set(syntheticId, {
        productId: syntheticId,
        articleCode: line.articleCode,
        productName: line.productName || line.articleCode,
        availableBales: 0,
        totalWeight: 0,
        selectedQty: line.quantity,
        pricePerBale: line.pricePerBale,
      });
    }
  });
  return newSelections;
}
