import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getErpRouteFeatureKeys } from "../shared/erpRouteAccess";

const source = (path: string) => readFileSync(path, "utf8");

describe("ERP Stock workspace keeps the existing operational tools", () => {
  it("exposes the company-authorized OTW feature alongside Stock Items, Query and Offload Search", () => {
    expect(getErpRouteFeatureKeys("/stock?tab=otw")).toEqual(["stock_items", "stock_query", "stock_otw"]);
    const hub = source("client/src/pages/StockHub.tsx");
    expect(hub).toContain('value: "items", label: "Stock Items"');
    expect(hub).toContain('value: "query", label: "Stock Query"');
    expect(hub).toContain('value: "offload", label: "Offload Search"');
    expect(hub).toContain('value: "otw", label: "On The Way"');
    expect(hub).toContain("<StockItems />");
    expect(hub).toContain("<StockQuery />");
    expect(hub).toContain("<OffloadItemSearch />");
    expect(hub).toContain("<StockOTW />");
  });

  it("preserves Stock Items Add, Manage, Import, and company-scoped backend wiring", () => {
    const view = source("client/src/pages/stockitems/StockItemsView.tsx");
    const dialogs = source("client/src/pages/stockitems/StockItemsDialogs.tsx");
    const model = source("client/src/pages/stockitems/useStockItems.ts");
    expect(view).toContain('data-testid="button-add-item"');
    expect(view).toContain('data-testid="button-manage-dropdown"');
    expect(view).toContain('data-testid="menu-import"');
    expect(dialogs).toContain("<StockItemCreateDialog");
    expect(dialogs).toContain("<CombinedImportDialog");
    expect(model).toContain('"/api/stock-items"');
  });

  it("reuses the same live OTW and container endpoints in both hubs without duplicate stock posting", () => {
    const otw = source("client/src/pages/StockOTW.tsx");
    const inventory = source("client/src/pages/InventoryHub.tsx");
    expect(otw).toContain("/api/containers?profile=otw-summary");
    expect(otw).toContain("/api/containers/otw-items?profile=stock-otw-v2");
    expect(inventory).toContain('value: "on-the-way"');
    expect(inventory).toContain("<StockOTW />");
    expect(inventory).toContain('"/stock?tab=otw"');
  });
});
