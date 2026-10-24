import type { useFactoryLocationInventory } from "../FactoryLocationInventoryModel";
import { isSpecialFactoryCategory } from "./utils";

type FactoryLocationInventoryModel = ReturnType<typeof useFactoryLocationInventory>;

export function createFactoryLocationProductMetrics(inventory: FactoryLocationInventoryModel) {
  const {
    activeInventoryData,
    categoryGroups,
    hiddenColumns,
    hideSellingPrice,
    proformaMode,
    regularProducts,
    setHiddenColumns,
    specialProducts,
  } = inventory;

  const allCategoryNames = [...categoryGroups]
    .sort((left, right) => left.categoryName.localeCompare(right.categoryName))
    .map((group) => group.categoryName);

  // Keep ordinary bales separate from Wipers/Garbage, using the same category
  // classification as the regular/special sections in the stock table.
  const stockBreakdown = activeInventoryData.reduce(
    (totals, product) => {
      const bales = product.baleCount - (product.loadingCount ?? 0);
      const kg = product.totalWeight;
      if (isSpecialFactoryCategory(product.category || "")) {
        totals.specialBales += bales;
        totals.specialKg += kg;
        if (bales > 0) totals.specialProductCount += 1;
      } else {
        totals.regularBales += bales;
        totals.regularKg += kg;
        if (bales > 0) totals.regularProductCount += 1;
      }
      return totals;
    },
    { regularBales: 0, regularKg: 0, specialBales: 0, specialKg: 0, regularProductCount: 0, specialProductCount: 0 }
  );
  const statsCostValue = activeInventoryData.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * product.productionPrice,
    0
  );
  const statsSellValue = activeInventoryData.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * parseFloat(product.sellingPrice || "0"),
    0
  );

  const totalBales = regularProducts.reduce((sum, product) => sum + product.baleCount - (product.loadingCount ?? 0), 0);
  const totalKg = regularProducts.reduce((sum, product) => sum + product.totalWeight, 0);
  const totalSellValue = regularProducts.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * parseFloat(product.sellingPrice || "0"),
    0
  );
  const totalProdValue = regularProducts.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * product.productionPrice,
    0
  );
  const spTotalBales = specialProducts.reduce(
    (sum, product) => sum + product.baleCount - (product.loadingCount ?? 0),
    0
  );
  const spTotalKg = specialProducts.reduce((sum, product) => sum + product.totalWeight, 0);
  const spTotalSellValue = specialProducts.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * parseFloat(product.sellingPrice || "0"),
    0
  );
  const spTotalProdValue = specialProducts.reduce(
    (sum, product) => sum + (product.baleCount - (product.loadingCount ?? 0)) * product.productionPrice,
    0
  );

  const col = (key: string) => !hiddenColumns.has(key);
  const toggleCol = (key: string) =>
    setHiddenColumns((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const colSpan =
    (proformaMode ? 1 : 0) +
    1 +
    (col("category") ? 1 : 0) +
    1 +
    (proformaMode ? 2 : 0) +
    (col("avg_kg") ? 1 : 0) +
    (!hideSellingPrice && col("sell_price") ? 1 : 0) +
    (!hideSellingPrice && col("sell_value") ? 1 : 0) +
    (!hideSellingPrice && col("cost_price") ? 1 : 0) +
    (!hideSellingPrice && col("cost_value") ? 1 : 0) +
    (col("total_kg") ? 1 : 0) +
    (!proformaMode && col("actions") ? 1 : 0);

  return {
    allCategoryNames,
    col,
    colSpan,
    spTotalBales,
    spTotalKg,
    spTotalProdValue,
    spTotalSellValue,
    ...stockBreakdown,
    statsCostValue,
    statsSellValue,
    toggleCol,
    totalBales,
    totalKg,
    totalProdValue,
    totalSellValue,
  };
}
