/**
 * getParentRoute decides where Back / Escape goes from a detail page: the
 * owning hub section, list or report. Every rule is listed here with a
 * concrete path, so a renamed route or a rule that shadows another fails
 * loudly instead of silently sending users to the wrong page.
 */
import { getParentRoute, isFactoryTopLevelPath } from "@/lib/parent-routes";

const PARENTS: Array<[path: string, parent: string]> = [
  ["/factory/containers/new", "/factory/containers-hub?section=containers"],
  ["/factory/sales/loading/new", "/factory/sales/loadings"],
  ["/factory/sales/loading/pending", "/factory/sales/loadings"],
  ["/factory/raw-stock/recalculate", "/factory/raw-materials"],
  ["/factory/bale-relabeling/wipers-re-entry", "/factory/bale-relabeling"],
  ["/factory/cost-centers", "/factory/accounts"],
  ["/properties/create", "/properties/rentals?tab=warehouses"],
  ["/properties/transfer", "/properties/rentals"],
  ["/properties/rental/warehouses", "/properties/rentals?tab=warehouses"],
  ["/properties/rental/shops", "/properties/rentals?tab=shops"],
  ["/properties/rental/payments", "/properties/rentals?tab=payments"],
  ["/properties/account-groups", "/properties/accounts"],
  ["/properties/balance-repair", "/properties/settings"],
  ["/supplier-profit-check", "/parties?tab=suppliers"],
  ["/pos-import", "/pos"],
  ["/stock-transfer-order", "/sales-tools?tab=transfers"],
  ["/po-import", "/containers"],
  ["/account-groups", "/accounts"],
  ["/cost-centers", "/accounts"],
  ["/account-transfer", "/accounts"],
  ["/import-stock-items", "/stock?tab=items"],
  ["/barcode-manager", "/stock?tab=items"],
  ["/erp/rental/warehouses", "/erp/rental/shops"],
  ["/erp/rental/payments", "/erp/rental/shops"],
  ["/ai-validation", "/ai-command-center"],
  ["/sp/reports", "/sp"],
  ["/sp/opening-stock", "/sp"],
  ["/sp/aliases", "/sp"],
  ["/sp/setup", "/sp"],
  ["/factory/employees/12", "/factory/payroll-hub?section=employees"],
  ["/factory/workers/3/attendance", "/factory/payroll-hub?section=workers"],
  ["/factory/customers/9", "/factory/parties?section=customers"],
  ["/factory/sales/invoices/41", "/factory/invoicing?tab=invoices"],
  ["/factory/sales/pending-invoices/41/verify", "/factory/invoicing?tab=invoices"],
  ["/factory/sales/proformas/8/add-line", "/factory/invoicing?tab=proformas"],
  ["/factory/invoices/41/loading-scan", "/factory/sales/invoices/41"],
  ["/factory/raw-stock/opening-balance/5/edit", "/factory/raw-materials"],
  ["/factory/stock-query/77", "/factory/stock-query"],
  ["/factory/bale-product-history/7/11/2026", "/factory/bale-product-history/7/11"],
  ["/factory/bale-product-history/7/11/2026/all", "/factory/bale-product-history/7/11"],
  ["/factory/bale-product-history/7/11", "/factory/location-inventory"],
  ["/factory/ledger-vouchers/cash-1/2026-10", "/factory/ledger-monthly/cash-1"],
  ["/factory/ledger-monthly/cash-1", "/factory/accounts"],
  ["/factory/voucher-detail/55", "/factory/vouchers"],
  ["/factory/vouchers/55/edit", "/factory/vouchers"],
  ["/factory/dispatch-batches/4/rides/2/scan", "/factory/dispatch-batches/4"],
  ["/factory/dispatch-batches/4", "/factory/dispatch-batches"],
  ["/factory/net-position-details/2026", "/factory/intelligence/financial-hub?section=net-position"],
  ["/factory/financial-snapshot", "/factory/analytics"],
  ["/factory/import-cycle-diagnostics", "/factory/settings"],
  ["/factory/inventory-repair", "/factory/settings"],
  ["/factory/company-data-reset", "/factory/settings"],
  ["/factory/orphaned-records", "/factory/settings"],
  ["/factory/deleted-items", "/factory/settings"],
  ["/properties/voucher-detail/3", "/properties/vouchers"],
  ["/properties/vouchers/3/edit", "/properties/vouchers"],
  ["/properties/ledger-vouchers/bank-2/2026-01", "/properties/ledger-monthly/bank-2"],
  ["/properties/ledger-monthly/bank-2", "/properties/accounts"],
  ["/properties/net-position-details", "/properties/settings"],
  ["/properties/import-cycle-diagnostics", "/properties/settings"],
  ["/properties/inventory-repair", "/properties/settings"],
  ["/properties/company-data-reset", "/properties/settings"],
  ["/properties/orphaned-records", "/properties/settings"],
  ["/properties/deleted-items", "/properties/settings"],
  ["/properties/chatbot-settings", "/properties/settings"],
  ["/suppliers/6/edit", "/parties?tab=suppliers"],
  ["/suppliers/6/proformas", "/parties?tab=suppliers"],
  ["/pos/edit/14", "/pos"],
  ["/purchase-orders/2/edit", "/containers"],
  ["/containers/30/verification", "/containers/30"],
  ["/containers/30", "/containers"],
  ["/offloads/12", "/containers"],
  ["/sales-report/by-customer", "/sales-report"],
  ["/ledger-vouchers/sales-9/2026-05", "/ledger-monthly/sales-9"],
  ["/ledger-monthly/sales-9", "/accounts"],
  ["/voucher-detail/101", "/vouchers"],
  ["/vouchers/101/edit", "/vouchers"],
  ["/stock-query/7", "/stock?tab=query"],
  ["/stock-items/7/history/3/2026", "/stock-items/7/history"],
  ["/stock-items/7/history", "/stock?tab=items"],
  ["/stock-items/7/monthly-summary", "/inventory?tab=by-location"],
  ["/locations/2/stock-items/7/vouchers/2026/10", "/locations/2/stock-items/7/history"],
  ["/locations/2/stock-items/7/history", "/inventory?tab=by-location"],
  ["/opening-stock/2026-01-01", "/opening-stock"],
  ["/closing-stock/2026-12-31", "/closing-stock-summary"],
  ["/net-position-details", "/settings"],
  ["/import-cycle-diagnostics", "/settings"],
  ["/inventory-repair", "/settings"],
  ["/balance-repair", "/settings"],
  ["/company-data-reset", "/settings"],
  ["/orphaned-records", "/settings"],
  ["/deleted-items", "/settings"],
  ["/account-migration/preview", "/settings"],
  ["/notification-settings", "/settings"],
  ["/chatbot-settings", "/settings"],
  ["/intercompany-links", "/settings"],
  ["/sp/migration", "/sp/setup"],
  ["/sp/gc-migration", "/sp/setup"],
];

describe("getParentRoute", () => {
  it.each(PARENTS)("%s → %s", (path, parent) => {
    expect(getParentRoute(path)).toBe(parent);
  });

  it("ignores the query string and hash", () => {
    expect(getParentRoute("/pos-import?source=csv")).toBe("/pos");
    expect(getParentRoute("/account-groups#assets")).toBe("/accounts");
    expect(getParentRoute("/factory/cost-centers?view=tree#top")).toBe("/factory/accounts");
  });

  it.each(["/", "/vouchers", "/factory/vouchers", "/factory/unknown/page", "/properties/rentals", "/no-such-page"])(
    "has no parent for %s",
    (path) => {
      expect(getParentRoute(path)).toBeNull();
    }
  );
});

describe("isFactoryTopLevelPath", () => {
  it("treats registry pages, with or without query state, as top level", () => {
    expect(isFactoryTopLevelPath("/factory/vouchers")).toBe(true);
    expect(isFactoryTopLevelPath("/factory/payroll-hub?section=workers")).toBe(true);
  });

  it("does not treat detail pages or ERP pages as Factory top level", () => {
    expect(isFactoryTopLevelPath("/factory/vouchers/55/edit")).toBe(false);
    expect(isFactoryTopLevelPath("/vouchers")).toBe(false);
  });
});
