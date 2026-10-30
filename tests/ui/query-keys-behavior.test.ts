/**
 * Query-key factories and the cache-family helpers they rely on. Every key
 * must start with the URL the shared query function fetches, carry the
 * company identity, and be identical for equivalent filters, so callers share
 * one cache entry and never reuse another company's data.
 */
import { QueryClient } from "@tanstack/react-query";
import {
  analyticsKeys,
  companyKeys,
  factoryKeys,
  inventoryKeys,
  normalizeFilters,
  referenceKeys,
  stockItemKeys,
} from "@/lib/queryKeys";
import {
  queryMatchesApiFamily,
  removeApiFamily,
  removeCompanyApiFamily,
  unwrapList,
} from "@/lib/frontendDataArchitecture";

describe("company and reference keys", () => {
  it.each([
    [companyKeys.scoped("/api/x", null, "a"), ["/api/x", "no-company", "a"]],
    [companyKeys.url("/api/x?b=1", 4, "id"), ["/api/x?b=1", 4, "id"]],
    [companyKeys.reference("/api/units", 4), ["/api/units", 4]],
    [companyKeys.accounts(4, { z: 1, a: "", b: true }), ["/api/accounts/all?b=true&z=1", 4]],
    [companyKeys.vouchers(undefined), ["/api/vouchers", "no-company"]],
    [companyKeys.dashboardCash(4), ["/api/dashboard-cash-accounts", 4]],
    [companyKeys.dashboardPayables(4), ["/api/dashboard-payable-accounts", 4]],
    [companyKeys.simpleTransfers(4), ["/api/simple-company-transfers", 4]],
    [companyKeys.companyAccounts(4, 9), ["/api/company-accounts/9", 4, 9]],
    [companyKeys.companyAccounts(4, null), ["/api/company-accounts/no-company", 4, null]],
    [companyKeys.autoTransferConfig(4, "/api/retail"), ["/api/retail/auto-transfer-config", 4]],
    [companyKeys.voucherSearch(4, "INV"), ["/api/vouchers/search", 4, "INV"]],
    [referenceKeys.locations(4, { active: true }), ["/api/locations?active=true", 4]],
    [referenceKeys.suppliers(4), ["/api/suppliers", 4]],
    [referenceKeys.customers(4, { q: "a" }), ["/api/customers?q=a", 4]],
    [referenceKeys.employees(4), ["/api/employees", 4]],
    [referenceKeys.stockGroups(4), ["/api/stock-groups", 4]],
    [referenceKeys.factoryWorkers(4), ["/api/factory/workers", 4]],
    [referenceKeys.factoryBaleProducts(4), ["/api/factory/bale-products", 4]],
    [referenceKeys.userCompanies(), ["/api/user/companies"]],
  ])("%j", (key, expected) => {
    expect(key).toEqual(expected);
  });
});

describe("filtered keys", () => {
  it("drops empty filters and sorts the rest", () => {
    expect(normalizeFilters(undefined)).toBeUndefined();
    expect(normalizeFilters({ a: "", b: null, c: undefined })).toBeUndefined();
    expect(Object.keys(normalizeFilters({ z: 0, a: false })!)).toEqual(["a", "z"]);
  });

  it.each([
    [factoryKeys.bales(4, { status: "open" }), ["/api/factory/bales", 4, { status: "open" }]],
    [factoryKeys.stockAllocation(4), ["/api/factory/v5/stock-allocation", 4, undefined]],
    [factoryKeys.daybook(4, { date: "" }), ["/api/factory/daybook", 4, undefined]],
    [factoryKeys.stockEntryHistory(4, { page: 2 }), ["/api/factory/bales/stock-entry-history", 4, { page: 2 }]],
    [inventoryKeys.list(4, { q: "x" }), ["/api/inventory", 4, { q: "x" }]],
    [stockItemKeys.identity(4), ["/api/stock-items/light?profile=identity", 4]],
    [stockItemKeys.light(4), ["/api/stock-items/light", 4]],
    [stockItemKeys.full(4), ["/api/stock-items", 4]],
    [stockItemKeys.page(4, { page: 2, q: null }), ["/api/stock-items?page=2", 4]],
  ])("%j", (key, expected) => {
    expect(key).toEqual(expected);
  });
});

describe("analytics keys", () => {
  it("reuse the reference and company keys so screens share their caches", () => {
    expect(analyticsKeys.locations(4)).toEqual(referenceKeys.locations(4));
    expect(analyticsKeys.stockGroups(4)).toEqual(referenceKeys.stockGroups(4));
    expect(analyticsKeys.suppliers(4)).toEqual(referenceKeys.suppliers(4));
    expect(analyticsKeys.userCompanies()).toEqual(referenceKeys.userCompanies());
    expect(analyticsKeys.accounts(4, "2026-01-01", "2026-01-31")).toEqual([
      "/api/accounts/all?endDate=2026-01-31&startDate=2026-01-01",
      4,
    ]);
  });

  it.each([
    [analyticsKeys.financialSales(4, { to: "b", from: "a" }), ["/api/financial/sales", 4, { from: "a", to: "b" }]],
    [analyticsKeys.financialTransactions(7, { from: "a" }), ["/api/financial/sales", 7, "transactions", { from: "a" }]],
    [analyticsKeys.urlScoped("/api/r", 4), ["/api/r", 4]],
    [analyticsKeys.factorySalesByCustomer(4, "u"), ["/api/factory/analytics/sales-by-customer", 4, "u"]],
    [analyticsKeys.factoryPosSummary(4, "u"), ["/api/factory/analytics/pos-summary", 4, "u"]],
    [analyticsKeys.netProfitStatement(4, "a", "b"), ["/api/reports/net-profit-statement", 4, "a", "b"]],
    [analyticsKeys.openingStockSummary(4, "3"), ["/api/reports/opening-stock-summary", 4, "3"]],
  ])("%j", (key, expected) => {
    expect(key).toEqual(expected);
  });
});

describe("cache families", () => {
  it("never matches a key without a URL", () => {
    expect(queryMatchesApiFamily([42], "/api/accounts")).toBe(false);
  });

  it("removes a family, or one company's slice of it", () => {
    const client = new QueryClient();
    const keys = [
      ["/api/accounts", 1],
      ["/api/accounts/all?x=1", 2],
      ["/api/accounts-old", 1],
      ["/api/bales", 1],
      ["/api/bales/5", 2],
    ];
    for (const key of keys) client.setQueryData(key, []);
    const remaining = () =>
      client
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey);

    removeCompanyApiFamily(client, "/api/bales", 2);
    expect(remaining()).not.toContainEqual(["/api/bales/5", 2]);
    expect(remaining()).toContainEqual(["/api/bales", 1]);

    removeApiFamily(client, "/api/accounts/");
    expect(remaining()).toEqual([
      ["/api/accounts-old", 1],
      ["/api/bales", 1],
    ]);
  });

  it("returns no rows for a payload with no list in it", () => {
    expect(unwrapList({ total: 3 })).toEqual([]);
  });
});
