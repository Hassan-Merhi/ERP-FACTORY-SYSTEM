import { beforeEach, describe, expect, it } from "vitest";
import { QUERY_STALE_TIMES, staleTimeForQueryKey, visibleTabInterval } from "@/lib/queryPolicies";
import { stockItemKeys } from "@/lib/queryKeys";
import { factoryCatalogLanguageCacheVariant } from "@/lib/factoryCatalogCacheVariant";

describe("Bandwidth Phase 4 request-pressure contracts", () => {
  beforeEach(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
  });

  it("stops polling while the browser tab is hidden", () => {
    const interval = visibleTabInterval(60_000);
    expect(interval()).toBe(60_000);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    expect(interval()).toBe(false);
  });

  it("keeps the compact stock selector on its dedicated identity cache key", () => {
    expect(stockItemKeys.identity(42)).toEqual(["/api/stock-items/light?profile=identity", 42]);
    expect(stockItemKeys.identity(undefined)).toEqual(["/api/stock-items/light?profile=identity", undefined]);
  });

  it("treats both stock-light profiles as long-lived reference data", () => {
    expect(staleTimeForQueryKey(stockItemKeys.identity(42))).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(stockItemKeys.light(42))).toBe(QUERY_STALE_TIMES.referenceData);
  });

  it("keeps Factory categories in the long-lived reference-data policy", () => {
    expect(staleTimeForQueryKey(["/api/factory/categories", 42])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/factory/categories?language=ar", 42])).toBe(QUERY_STALE_TIMES.referenceData);
  });

  it("keeps language-specific Bale Products catalogs on the same long-lived policy", () => {
    expect(staleTimeForQueryKey(["/api/factory/bale-products?lang=en", 42])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/factory/bale-products?lang=ar", 42])).toBe(QUERY_STALE_TIMES.referenceData);
    expect(staleTimeForQueryKey(["/api/factory/bale-products?lang=fr", 42])).toBe(QUERY_STALE_TIMES.referenceData);
  });

  it("separates lower browser cache variants by Factory catalog language", () => {
    const url = new URL("/api/factory/categories", "https://erp.example");
    const headers = new Headers();

    expect(factoryCatalogLanguageCacheVariant(url, headers, "factory_catalog_language=en")).toBe(
      "factory-catalog-language=en"
    );
    expect(factoryCatalogLanguageCacheVariant(url, headers, "factory_catalog_language=fr")).toBe(
      "factory-catalog-language=fr"
    );

    headers.set("x-factory-catalog-language", "ar");
    expect(factoryCatalogLanguageCacheVariant(url, headers, "factory_catalog_language=fr")).toBe(
      "factory-catalog-language=ar"
    );

    url.searchParams.set("lang", "fr");
    expect(factoryCatalogLanguageCacheVariant(url, headers, "factory_catalog_language=en")).toBe(
      "factory-catalog-language=fr"
    );

    expect(
      factoryCatalogLanguageCacheVariant(new URL("/api/accounts/all", "https://erp.example"), headers, "")
    ).toBe("factory-catalog-language=none");
  });

});
