import { ERP_POS_ROLE_ROUTES, getErpRouteFeatureKeys, isErpDeveloperOnlyRoute } from "@shared/erpRouteAccess";

describe("shared ERP route access (sidebar and training videos)", () => {
  it("maps feature pages and leaves open pages without a key", () => {
    expect(getErpRouteFeatureKeys("/daybook?x=1")).toEqual(["daybook"]);
    expect(getErpRouteFeatureKeys("/inventory")).toEqual(["location_inventory", "stock_otw", "containers"]);
    expect(getErpRouteFeatureKeys("/tickets")).toEqual([]);
  });

  it("keeps developer-only pages to developers", () => {
    expect(isErpDeveloperOnlyRoute("/accounting/toolbox")).toBe(true);
    expect(isErpDeveloperOnlyRoute("/cost-centers#a")).toBe(true);
    expect(isErpDeveloperOnlyRoute("/tickets")).toBe(false);
    expect(isErpDeveloperOnlyRoute("/sales-tools")).toBe(false);
  });

  it("lists the POS role's ERP pages", () => {
    expect(ERP_POS_ROLE_ROUTES).toContain("/sales-tools");
    expect(ERP_POS_ROLE_ROUTES).not.toContain("/tickets");
  });
});
