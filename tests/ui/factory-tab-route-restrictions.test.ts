import { describe, expect, it } from "vitest";
import { computeFactoryGuardRedirect, type MyAccess } from "@/app/factoryAccessGuard";
import { resolveFactoryTabRouteRestriction } from "@/app/factoryTabRouteRestrictions";

const unrestricted: MyAccess = {
  fullAccess: true,
  pageKeys: [],
  hasErpAccess: true,
  hasFactoryAccess: true,
  hiddenCostFields: [],
};

function redirectFor(path: string, hiddenCostFields: string[]) {
  return computeFactoryGuardRedirect({
    isFactoryRoute: true,
    isAdminOwner: false,
    myAccess: { ...unrestricted, hiddenCostFields },
    factorySettings: undefined,
    factoryDefaultPage: "/factory/production-report",
    currentLocation: path,
  });
}

describe("Factory direct tab route restrictions", () => {
  it("maps representative deep routes to their owning tabs", () => {
    expect(resolveFactoryTabRouteRestriction("/factory/customers/12")?.hiddenKeys).toContain(
      "hide_tab_parties_customers"
    );
    expect(resolveFactoryTabRouteRestriction("/factory/sales/invoices/99")?.hiddenKeys).toContain(
      "hide_invoicing_invoices_tab"
    );
    expect(resolveFactoryTabRouteRestriction("/factory/ledger-vouchers/5/2026/9")?.hiddenKeys).toContain(
      "hide_tab_accounts_view"
    );
    expect(resolveFactoryTabRouteRestriction("/factory/dispatch-batches/7")?.hiddenKeys).toContain(
      "hide_tab_dispatch_batches"
    );
    expect(resolveFactoryTabRouteRestriction("/factory/dispatch-batches")).toBeNull();
  });

  it("redirects hidden direct tabs to their parent hub", () => {
    expect(redirectFor("/factory/customers/12", ["hide_tab_parties_customers"])).toBe("/factory/parties");
    expect(redirectFor("/factory/sales/invoices/99", ["hide_invoicing_invoices_tab"])).toBe("/factory/invoicing");
    expect(redirectFor("/factory/ledger-monthly/12", ["hide_tab_accounts_view"])).toBe("/factory/accounts");
    expect(redirectFor("/factory/dispatch-batches/7", ["hide_tab_dispatch_batches"])).toBe("/factory/dispatch-batches");
  });

  it("does not redirect the dispatch hub root or visible direct tabs", () => {
    expect(redirectFor("/factory/dispatch-batches", ["hide_tab_dispatch_batches"])).toBeNull();
    expect(redirectFor("/factory/customers/12", [])).toBeNull();
  });

  it("keeps privileged role bypass behavior unchanged", () => {
    expect(
      computeFactoryGuardRedirect({
        isFactoryRoute: true,
        isAdminOwner: true,
        userRole: "Admin",
        myAccess: { ...unrestricted, hiddenCostFields: ["hide_tab_parties_customers"] },
        factorySettings: undefined,
        factoryDefaultPage: "/factory/production-report",
        currentLocation: "/factory/customers/12",
      })
    ).toBeNull();
  });
});
