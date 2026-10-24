/**
 * Retail inventory is the only dedicated stock workspace. Retail POS remains
 * available through /pos and stock transfers live under Vouchers.
 */
import { resolveAuthenticatedAppRoute } from "@/app/authenticatedAppRouteGuard";
import { RETAIL_NAV_LINKS } from "@/pages/retail/RetailNav";

const route = (currentLocation: string, companyType: string) =>
  resolveAuthenticatedAppRoute({
    currentLocation,
    companyType,
    isAdminOwner: true,
    userRole: "Admin",
    myAccessLoading: false,
    myAccessError: false,
  }).decision;

describe("Retail navigation", () => {
  it("lists only the Retail inventory workspace", () => {
    expect(RETAIL_NAV_LINKS.map((link) => link.href)).toEqual(["/retail/inventory"]);
  });

  it("redirects old Selling settings bookmarks to Retail Inventory", () => {
    expect(route("/retail/selling", "retail")).toEqual({ kind: "redirect", to: "/retail/inventory" });
  });

  it("redirects retired retail quick-add, stock operations and optional vouchers", () => {
    for (const path of ["/retail/quick-add", "/retail/stock", "/optional-vouchers"]) {
      expect(route(path, "retail")).toEqual({ kind: "redirect", to: "/retail/inventory" });
      expect(route(path, "erp")).toEqual(
        path.startsWith("/retail/") ? { kind: "redirect", to: "/tracking" } : { kind: "continue" }
      );
    }
  });

  it("sends the standard POS entry to the variant-aware Retail POS", () => {
    expect(route("/pos", "retail")).toEqual({ kind: "redirect", to: "/retail/pos" });
  });

  it("redirects legacy Transfer Order links to Retail Vouchers, for Retail only", () => {
    expect(route("/stock-transfer-order", "retail")).toEqual({ kind: "redirect", to: "/vouchers?tab=transfer" });
    expect(route("/stock-transfer-order/12", "retail")).toEqual({ kind: "redirect", to: "/vouchers?tab=transfer" });
    expect(route("/stock-transfer-order", "erp")).toEqual({ kind: "continue" });
  });
});
