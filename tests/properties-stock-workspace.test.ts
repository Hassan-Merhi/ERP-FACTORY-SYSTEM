import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  canNavigateProperties,
  findPropertiesNavigationEntry,
  getPropertiesParentRoute,
} from "../client/src/properties/config/propertiesNavigation";

const source = (path: string) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const company = (role: string) => ({ companyType: "properties" as const, role });

describe("Properties Stock/OTW workspace", () => {
  it("registers Stock, item details and Excel import inside Properties for trading roles only", () => {
    for (const path of [
      "/properties/stock",
      "/properties/stock?tab=items",
      "/properties/stock?tab=query",
      "/properties/stock?tab=offload",
      "/properties/stock?tab=otw",
      "/properties/stock-query/123",
      "/properties/import-stock-items",
    ]) {
      expect(findPropertiesNavigationEntry(path)).toBeDefined();
      expect(canNavigateProperties(path, { role: "User" }, company("Developer"))).toBe(true);
      expect(canNavigateProperties(path, { role: "User" }, company("Owner"))).toBe(true);
      expect(canNavigateProperties(path, { role: "Developer" }, company("User"))).toBe(false);
      expect(canNavigateProperties(path, { role: "Developer" }, { companyType: "erp", role: "Developer" })).toBe(
        false
      );
    }
  });

  it("keeps Properties stock page roots and detail/import Back destinations correct", () => {
    expect(getPropertiesParentRoute("/properties/stock?tab=otw")).toBeNull();
    expect(getPropertiesParentRoute("/properties/stock-query/123")).toBe("/properties/stock?tab=query");
    expect(getPropertiesParentRoute("/properties/import-stock-items")).toBe("/properties/stock?tab=items");
  });

  it("adds the real four-tab Stock hub to Properties sidebar and authenticated routing", () => {
    const sidebar = source("client/src/components/PropertiesSidebar.tsx");
    const routes = source("client/src/app/PropertiesRoutes.tsx");
    const stockHub = source("client/src/pages/StockHub.tsx");
    expect(sidebar).toContain('{ title: "Stock", url: "/properties/stock", icon: Package }');
    expect(routes).toContain('path="/properties/stock-query/:id" component={StockItemDetail}');
    expect(routes).toContain('path="/properties/import-stock-items" component={ImportStockItems}');
    expect(routes).toContain('<Route path="/properties/stock">{() => <StockHub />}</Route>');
    for (const name of ["Stock Items", "Stock Query", "Offload Search", "On The Way"]) {
      expect(stockHub).toContain('label: "' + name + '"');
    }
  });

  it("keeps Add, Manage, Import and OTW on the existing company-selected APIs", () => {
    const view = source("client/src/pages/stockitems/StockItemsView.tsx");
    const importDialog = source("client/src/components/CombinedImportDialog.tsx");
    const otw = source("client/src/pages/StockOTW.tsx");
    expect(view).toContain('data-testid="button-add-item"');
    expect(view).toContain('data-testid="button-manage-dropdown"');
    expect(view).toContain('data-testid="menu-import"');
    expect(importDialog).toContain('"/properties/import-stock-items"');
    expect(otw).toContain("/api/containers/otw-items?profile=stock-otw-v2");
  });

  it("keeps stock details, back navigation and receipt links inside Properties", () => {
    const query = source("client/src/pages/StockQuery.tsx");
    const detail = source("client/src/pages/StockItemDetail.tsx");
    expect(query).toContain("selectedCompany?.companyType === \"properties\"");
    expect(query).toContain("/properties/stock-query/");
    expect(detail).toContain('useRoute("/properties/stock-query/:id")');
    expect(detail).toContain('"/properties/stock?tab=query"');
    expect(detail).toContain("/properties/vouchers/");
  });
});
