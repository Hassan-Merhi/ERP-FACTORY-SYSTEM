import { describe, expect, it } from "vitest";
import { visibleVariants, variantQuantity, type RetailCatalogFilters } from "@/pages/retail/RetailCatalogList";
import type { RetailProduct, RetailVariant } from "@/pages/retail/retailInventoryTypes";

const baseFilters: RetailCatalogFilters = {
  color: "",
  size: "",
  locationId: "",
  stockStatus: "all",
  showArchived: false,
};

const variant = (overrides: Partial<RetailVariant> = {}): RetailVariant => ({
  id: 1,
  color: "Grey",
  size: "M",
  imageUrls: ["/api/retail/media/photo-1"],
  barcode: "2000000000015",
  sku: null,
  cost: 100,
  sellingPrice: 200,
  lowStockThreshold: 2,
  active: true,
  quantity: 3,
  stocks: [
    { locationId: 1, locationName: "Main", quantity: 0 },
    { locationId: 2, locationName: "Mall", quantity: 3 },
  ],
  ...overrides,
});

const product: RetailProduct = {
  id: 5,
  code: "RTL-SKINNY-PANTS",
  name: "Skinny pants",
  category: null,
  imageUrls: [],
  active: true,
  brand: { id: 2, name: "ADIUM" },
  variants: [variant()],
  availableColors: ["Grey"],
  availableSizes: ["M"],
  totalQuantity: 3,
  minSellingPrice: 200,
  maxSellingPrice: 200,
};

describe("Retail inventory redesign regressions", () => {
  it("keeps location-specific quantity rather than displaying stock from other branches", () => {
    expect(variantQuantity(product.variants[0], "1")).toBe(0);
    expect(variantQuantity(product.variants[0], "2")).toBe(3);
    expect(variantQuantity(product.variants[0], "")).toBe(3);
  });

  it("keeps out-of-stock filtering and exact color/size matching after layout changes", () => {
    expect(visibleVariants(product, { ...baseFilters, locationId: "1", stockStatus: "out" })).toHaveLength(1);
    expect(visibleVariants(product, { ...baseFilters, locationId: "1", stockStatus: "in" })).toHaveLength(0);
    expect(visibleVariants(product, { ...baseFilters, color: "grey", size: "M" })).toHaveLength(1);
    expect(visibleVariants(product, { ...baseFilters, size: "L" })).toHaveLength(0);
  });

  it("does not expose archived variants unless explicitly requested", () => {
    const archived = { ...product, variants: [variant({ active: false })] };
    expect(visibleVariants(archived, baseFilters)).toHaveLength(0);
    expect(visibleVariants(archived, { ...baseFilters, showArchived: true })).toHaveLength(1);
  });
});
