import { describe, expect, it } from "vitest";
import {
  FACTORY_TAB_REGISTRY,
  isFactoryTabVisibleInProfile,
  resolveFactoryEffectiveHiddenFields,
  setFactoryTabVisibleInProfile,
} from "@shared/factoryPermissionCatalog";

const customerLoading = FACTORY_TAB_REGISTRY.find((tab) => tab.key === "hide_tab_bales_customer_loading")!;
const products = FACTORY_TAB_REGISTRY.find((tab) => tab.key === "hide_tab_bales_products")!;

describe("opt-in Factory tabs", () => {
  it("hides Customer Loading for users without an explicit grant", () => {
    expect(customerLoading.grantKey).toBe("show_tab_bales_customer_loading");
    expect(isFactoryTabVisibleInProfile(customerLoading, [])).toBe(false);
    expect(resolveFactoryEffectiveHiddenFields([])).toContain("hide_tab_bales_customer_loading");
    expect(isFactoryTabVisibleInProfile(products, [])).toBe(true);
  });

  it("shows Customer Loading once granted and removes the grant when hidden again", () => {
    const granted = setFactoryTabVisibleInProfile(["inventory_avg_rate"], customerLoading, true);
    expect(granted).toEqual(["inventory_avg_rate", "show_tab_bales_customer_loading"]);
    expect(isFactoryTabVisibleInProfile(customerLoading, granted)).toBe(true);
    expect(resolveFactoryEffectiveHiddenFields(granted)).not.toContain("hide_tab_bales_customer_loading");

    const revoked = setFactoryTabVisibleInProfile(granted, customerLoading, false);
    expect(isFactoryTabVisibleInProfile(customerLoading, revoked)).toBe(false);
    expect(revoked).not.toContain("show_tab_bales_customer_loading");
  });

  it("keeps regular tabs on hide-key semantics", () => {
    const hidden = setFactoryTabVisibleInProfile([], products, false);
    expect(hidden).toEqual(["hide_tab_bales_products"]);
    expect(setFactoryTabVisibleInProfile(hidden, products, true)).toEqual([]);
  });
});
