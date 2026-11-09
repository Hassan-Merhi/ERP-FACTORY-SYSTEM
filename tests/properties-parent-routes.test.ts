import { describe, expect, it } from "vitest";
import { getParentRoute } from "../client/src/lib/parent-routes";
import { getPropertiesParentRoute, findPropertiesNavigationEntry, PROPERTIES_NAVIGATION } from "../client/src/properties/config/propertiesNavigation";

describe("Properties parent route registry", () => {
  it.each([
    ["/properties/create", "/properties/rentals?tab=warehouses"],
    ["/properties/transfer", "/properties/rentals"],
    ["/properties/rental/warehouses", "/properties/rentals?tab=warehouses"],
    ["/properties/rental/shops", "/properties/rentals?tab=shops"],
    ["/properties/rental/payments", "/properties/rentals?tab=payments"],
    ["/properties/voucher-detail/99", "/properties/vouchers"],
    ["/properties/vouchers/99/edit", "/properties/vouchers"],
    ["/properties/ledger-vouchers/12/2026/7", "/properties/ledger-monthly/12"],
    ["/properties/ledger-monthly/12", "/properties/accounts"],
    ["/properties/account-groups", "/properties/accounts"],
    ["/properties/net-position-details", "/properties/settings"],
    ["/properties/import-cycle-diagnostics", "/properties/settings"],
    ["/properties/inventory-repair", "/properties/settings"],
    ["/properties/company-data-reset", "/properties/settings"],
    ["/properties/orphaned-records", "/properties/settings"],
    ["/properties/deleted-items", "/properties/settings"],
    ["/properties/chatbot-settings", "/properties/settings"],
    ["/properties/balance-repair", "/properties/settings"],
  ])("maps %s to %s", (path, expected) => {
    expect(getParentRoute(path)).toBe(expected);
  });

  it("ignores query strings and hashes", () => {
    expect(getParentRoute("/properties/create?source=dashboard#form")).toBe(
      "/properties/rentals?tab=warehouses",
    );
  });

  it("does not invent parents for Properties roots", () => {
    expect(getParentRoute("/properties/daybook")).toBeNull();
    expect(getParentRoute("/properties/rentals")).toBeNull();
    expect(getParentRoute("/properties/accounts")).toBeNull();
    expect(getParentRoute("/properties/vouchers")).toBeNull();
    expect(getParentRoute("/properties/settings")).toBeNull();
    expect(getParentRoute("/properties/my-settings")).toBeNull();
  });
});

describe("Phase 13 single-source Properties parent contract", () => {
  it("keeps registry metadata and Back/Escape destinations aligned", () => {
    for (const entry of PROPERTIES_NAVIGATION) {
      if (entry.path.includes("/:") || entry.path.includes("?")) continue;
      expect(getPropertiesParentRoute(entry.path)).toBe(entry.parent);
      expect(getParentRoute(entry.path)).toBe(entry.parent);
    }
  });

  it("preserves exact deep-link parent identity and query/hash handling", () => {
    expect(getParentRoute("/properties/ledger-vouchers/45/2026/11?from=accounts#table")).toBe("/properties/ledger-monthly/45");
    expect(getParentRoute("/properties/ledger-vouchers/45/2026-11")).toBe("/properties/ledger-monthly/45");
    expect(getParentRoute("/properties/ledger-monthly/45/")).toBe("/properties/accounts");
    expect(getParentRoute("/properties/vouchers/10/edit?source=daybook")).toBe("/properties/vouchers");
    expect(getParentRoute("/properties/account-groups")).toBe("/properties/accounts");
    expect(getParentRoute("/properties/create")).toBe("/properties/rentals?tab=warehouses");
  });

  it("does not infer parents from similar-looking or malformed paths", () => {
    for (const path of [
      "/properties/not-a-route", "/properties/create/more", "/properties/account-groups/extra",
      "/properties/ledger-vouchers/45", "/properties/ledger-vouchers/45/2026/11/extra",
      "/properties/voucher-detail/", "/properties/vouchers/10/edit/extra",
      "/properties/accounting/toolbox/extra",
    ]) {
      expect(getPropertiesParentRoute(path)).toBeNull();
      expect(getParentRoute(path)).toBeNull();
    }
  });

  it("retains compatibility destinations and root no-parent behavior", () => {
    expect(getParentRoute("/properties/rental/shops?from=bookmark")).toBe("/properties/rentals?tab=shops");
    expect(getParentRoute("/properties/rental/payments")).toBe("/properties/rentals?tab=payments");
    expect(getParentRoute("/properties/rental/warehouses")).toBe("/properties/rentals?tab=warehouses");
    expect(getParentRoute("/properties/dashboard")).toBeNull();
    expect(getParentRoute("/properties/rentals?tab=shops")).toBeNull();
    expect(findPropertiesNavigationEntry("/properties/ledger-vouchers/45/2026/11")?.parent).toBe("/properties/ledger-monthly/:accountId");
  });
});
