import { describe, expect, it } from "vitest";
import { resolveFactoryPage } from "../shared/factoryAccessRegistry";
import {
  FACTORY_HUB_HIDDEN_TABS,
  FACTORY_OTHERS_NAV_LINKS,
  FACTORY_SALES_DISPATCH_ROUTES,
  FACTORY_WORKERS_HUB_TABS,
  factoryHubTabHideKey,
} from "../client/src/factory/config/navigationPresentation";

describe("Factory Phase 4 navigation presentation contract", () => {
  it("preserves separately guarded POS and waste dispatch destinations", () => {
    expect(FACTORY_SALES_DISPATCH_ROUTES.pos).toBe("/factory/pos");
    expect(FACTORY_SALES_DISPATCH_ROUTES.wasteDispatch).toBe("/factory/waste-dispatch");
    expect(resolveFactoryPage(FACTORY_SALES_DISPATCH_ROUTES.pos)?.key).toBe("factory/pos");
    expect(resolveFactoryPage(FACTORY_SALES_DISPATCH_ROUTES.wasteDispatch)?.key).toBe("factory/waste-dispatch");
  });
  it("preserves existing Others query tabs and their permissions", () => {
    expect(FACTORY_OTHERS_NAV_LINKS.map((item) => item.url)).toEqual([
      "/factory/others?tab=comparison",
      "/factory/others?tab=product-comparison",
    ]);
    expect(FACTORY_OTHERS_NAV_LINKS.every((item) => item.accessKey === "factory/production-report")).toBe(true);
    for (const item of FACTORY_OTHERS_NAV_LINKS) {
      expect(factoryHubTabHideKey("/factory/others", item.url.split("tab=")[1])).toBe(item.hideKey);
    }
  });
  it("retains existing Factory hub tab hide keys and leaves unknown tabs unclassified", () => {
    expect(factoryHubTabHideKey("/factory/invoicing", "pending")).toBe("hide_tab_loadings_pending");
    expect(factoryHubTabHideKey("/factory/sales/loadings", "priority")).toBe("hide_tab_loadings_pending");
    expect(factoryHubTabHideKey("/factory/bales-hub", "barcode")).toBe("hide_tab_bales_barcode");
    expect(factoryHubTabHideKey("/factory/payroll-hub", "insurance")).toBe("hide_tab_payrollhub_insurance");
    expect(factoryHubTabHideKey("/factory/others", "unexpected")).toBeUndefined();
    expect(FACTORY_HUB_HIDDEN_TABS["/factory/parties"].suppliers).toBe("hide_tab_parties_suppliers");
  });
  it("preserves worker hub hide keys with exact tab values", () => {
    expect(Object.keys(FACTORY_WORKERS_HUB_TABS)).toEqual([
      "workers", "payroll", "attendance", "report", "advances", "bonuses",
    ]);
    expect(FACTORY_WORKERS_HUB_TABS.attendance).toBe("hide_tab_workers_attendance");
  });
});
