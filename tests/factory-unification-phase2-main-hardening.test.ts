import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { companyQueryKey } from "../client/src/lib/companyQueryScope";

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

describe("Factory Phase 2 follow-up isolation on main", () => {
  const scopedPages: Record<string, string[]> = {
    "client/src/pages/factory/FactoryAlerts.tsx": ["/api/factory/alerts"],
    "client/src/pages/factory/FactoryWaste.tsx": ["/api/factory/waste"],
    "client/src/pages/factory/FactoryPriceList.tsx": ["/api/factory/bale-products", "/api/factory/categories"],
    "client/src/pages/factory/CustomerLogosSettings.tsx": ["/api/factory/customers"],
    "client/src/pages/factory/FactoryContacts.tsx": ["/api/factory/contacts"],
    "client/src/pages/factory/FactoryCustomers.tsx": ["/api/factory/customers"],
    "client/src/pages/factory/ProductionSummary.tsx": ["/api/factory/bales", "/api/factory/raw-stock"],
    "client/src/pages/StockEntryHistory.tsx": ["/api/factory/my-access", "/api/factory/bales/stock-entry-history", "/api/factory/staff-tracking"],
    "client/src/pages/baleproducts/useBaleProductsModel.tsx": ["/api/factory/my-access", "/api/factory/bale-products", "/api/factory/categories"],
  };

  for (const [path, urls] of Object.entries(scopedPages)) {
    it(`uses selected-company keys in ${path}`, () => {
      const code = source(path);
      for (const url of urls) expect(code).toContain(`companyQueryKey("${url}", selectedCompany?.id`);
    });
  }

  it("does not show bale product costs before matching access is known", () => {
    const code = source("client/src/pages/baleproducts/useBaleProductsModel.tsx");
    expect(code).toContain("myAccess?.companyId === selectedCompany?.id");
    expect(code).toContain("myAccess?.hasFactoryAccess === true");
    expect(code).toContain("!accessReady || myAccess?.hideAllCosts === true");
  });

  it("matches waste mutations to the exact company-scoped read", () => {
    const code = source("client/src/pages/factory/FactoryWaste.tsx");
    expect(code).toContain('queryKey: companyQueryKey("/api/factory/waste", selectedCompany?.id, from, to)');
    expect(code).toContain('invalidateQueries({ queryKey: companyQueryKey("/api/factory/waste", selectedCompany?.id, from, to) })');
  });

  it("keeps customer logo edits from retaining a prior company picker", () => {
    const code = source("client/src/pages/factory/CustomerLogosSettings.tsx");
    expect(code).toContain("setSelectedCustomerId(\"\")");
    expect(code).toContain("}, [selectedCompany?.id]);");
    expect(code).toContain('companyQueryKey("/api/factory/customers", selectedCompany?.id, selectedCustomerId, "logos")');
  });

  it("preserves URL-first query prefixes and different identities", () => {
    expect(companyQueryKey("/api/factory/bale-products", 1)[0]).toBe("/api/factory/bale-products");
    expect(companyQueryKey("/api/factory/bale-products", 1)).not.toEqual(
      companyQueryKey("/api/factory/bale-products", 2),
    );
  });
});
