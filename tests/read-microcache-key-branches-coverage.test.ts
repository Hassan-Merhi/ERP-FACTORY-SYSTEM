import { describe, expect, it } from "vitest";
import type { Request } from "express";

import {
  buildReadMicrocacheKey,
  buildReadScope,
  buildWriteInvalidation,
  entryMatchesInvalidation,
  etagMatches,
  makeEtag,
} from "../server/routes/performance/buildReadMicrocacheKey";

function fakeReq(path: string, extra: Partial<Record<string, unknown>> = {}): Request {
  return {
    path,
    originalUrl: path,
    url: path,
    method: "GET",
    query: {},
    headers: {},
    body: undefined,
    session: { currentCompanyId: 7 },
    ...extra,
  } as unknown as Request;
}

const topicsFor = (path: string) => buildReadScope(fakeReq(path)).topics;

describe("read microcache scope topics", () => {
  const cases: Array<[string[], string[] | undefined]> = [
    [["/api/locations/4/inventory", "/api/locations/4/inventory/light/"], ["inventory"]],
    [["/api/accounts/ledger/9/transactions"], ["accounting", "fx"]],
    [["/api/vouchers/3"], ["accounting"]],
    [["/api/factory/customer-orders/5", "/api/factory/customer-proformas/x"], ["factory"]],
    [["/api/factory/workers/attendance-report"], ["factory", "payroll"]],
    [["/api/sales-report"], ["pos", "accounting", "inventory", "reference"]],
    [["/api/dashboard/sales-report-all"], ["pos", "accounting", "inventory", "reference", "fx"]],
    [["/api/pos/last-sold-prices"], ["pos", "accounting"]],
    [["/api/location-summary"], ["inventory"]],
    [
      ["/api/stock-items", "/api/stock-items/light", "/api/stock-items/all-code-aliases", "/api/locations"],
      ["reference"],
    ],
    [
      ["/api/reports/stock-movement", "/api/reports/opening-stock-summary", "/api/stock-transfers"],
      ["inventory", "accounting"],
    ],
    [
      ["/api/reports/containers", "/api/containers", "/api/containers/active", "/api/containers/otw-items"],
      ["containers", "inventory", "accounting"],
    ],
    [["/api/accounts/all"], ["accounting", "reference", "fx"]],
    [["/api/daybook", "/api/stats/monthly-data"], ["accounting"]],
    [["/api/accounts/voucher-sidebar"], ["accounting", "fx"]],
    [
      ["/api/ledger-accounts", "/api/ledger-accounts/parent-groups"],
      ["reference", "fx"],
    ],
    [
      ["/api/factory/payrolls", "/api/factory/payrolls/preview"],
      ["factory", "payroll", "accounting"],
    ],
    [["/api/payroll/worker-payments-summary"], ["factory", "payroll", "accounting"]],
    [["/api/factory/daily-bale-scans", "/api/factory/daily-bale-scans/produced"], ["scans"]],
    [
      [
        "/api/factory/raw-stock",
        "/api/factory/raw-stock/available-containers",
        "/api/factory/mix-batches",
        "/api/factory/bale-ledger",
        "/api/factory/production-value-report",
        "/api/factory/bales/stock-entry-history",
      ],
      ["factory", "inventory"],
    ],
    [["/api/factory/containers"], ["factory", "containers"]],
    [
      ["/api/factory/daybook", "/api/factory/suppliers/with-balances"],
      ["factory", "accounting"],
    ],
    [
      [
        "/api/factory/bale-products",
        "/api/factory/categories",
        "/api/factory/settings",
        "/api/factory/my-access",
        "/api/factory/suppliers",
        "/api/factory/worker-categories",
      ],
      ["reference"],
    ],
    [["/api/factory/customers"], ["factory", "accounting", "reference", "fx"]],
    [["/api/factory/cash-accounts"], ["reference", "accounting"]],
    [
      ["/api/factory/workers", "/api/factory/employees"],
      ["reference", "payroll", "accounting"],
    ],
    [["/api/factory/anything-else"], ["factory"]],
    [
      [
        "/api/company-settings",
        "/api/user/preferences",
        "/api/fixed-assets",
        "/api/stock-categories",
        "/api/stock-grades",
        "/api/stock-groups",
        "/api/suppliers",
        "/api/worker-groups/with-members",
        "/api/employee-groups",
        "/api/user/companies",
        "/api/my-erp-pages",
        "/api/payroll/bonus-locations",
      ],
      ["reference"],
    ],
    [
      ["/api/customers", "/api/bank-accounts"],
      ["reference", "fx"],
    ],
    [["/api/not-cached"], undefined],
    [["/api/stats/net-profit"], ["fx"]],
  ];

  it.each(cases)("maps %j to its topics", (paths, expected) => {
    for (const path of paths) expect(topicsFor(path), path).toEqual(expected);
  });

  it("scopes company and location ids, but not for the all-company sales report", () => {
    const scoped = buildReadScope(fakeReq("/api/locations/12/inventory", { query: { locationId: ["13", "x", 0] } }));
    expect(scoped).toEqual({ companyIds: [7], topics: ["inventory"], locationIds: [12, 13] });
    expect(buildReadScope(fakeReq("/api/dashboard/sales-report-all")).companyIds).toEqual([]);
    const noCompany = buildReadScope(fakeReq("/api/not-cached", { session: {} }));
    expect(noCompany).toEqual({ companyIds: [] });
  });
});

describe("read microcache write invalidation", () => {
  it("keeps the blanket fallback for unclassified writes", () => {
    expect(buildWriteInvalidation(fakeReq("/api/unknown-family/1", { method: "POST", body: {} }))).toEqual({});
  });

  it("drops the reference topic for proforma transfers and keeps it elsewhere", () => {
    const transfer = buildWriteInvalidation(
      fakeReq("/api/factory/customer-proformas/123/transfer", {
        method: "POST",
        originalUrl: "/api/factory/customer-proformas/123/transfer?x=1",
        body: {},
      })
    );
    expect(transfer).toEqual({ companyIds: [7], topics: ["factory"] });

    const reference = buildWriteInvalidation(
      fakeReq("/api/suppliers", { method: "POST", originalUrl: "", url: "/api/suppliers", body: {}, session: {} })
    );
    expect(reference).toEqual({ topics: ["reference"] });
  });
});

describe("read microcache entry matching", () => {
  const entry = (scope: Record<string, unknown>) => ({ scope }) as never;

  it("evaluates company, topic and location filters", () => {
    expect(entryMatchesInvalidation(entry({ companyIds: [] }), { companyIds: [1] })).toBe(true);
    expect(entryMatchesInvalidation(entry({ companyIds: [2] }), { companyIds: [1] })).toBe(false);
    expect(entryMatchesInvalidation(entry({ companyIds: [1] }), { companyIds: [1], topics: ["fx"] })).toBe(true);
    expect(entryMatchesInvalidation(entry({ companyIds: [1], topics: ["inventory"] }), { topics: ["fx"] })).toBe(false);
    expect(entryMatchesInvalidation(entry({ companyIds: [1], topics: ["fx"] }), { topics: ["fx"] })).toBe(true);
    expect(entryMatchesInvalidation(entry({ companyIds: [1], locationIds: [3] }), { locationIds: [4] })).toBe(false);
    expect(entryMatchesInvalidation(entry({ companyIds: [1], locationIds: [3] }), { locationIds: [3] })).toBe(true);
    expect(entryMatchesInvalidation(entry({ companyIds: [1] }), { locationIds: [3] })).toBe(true);
    expect(entryMatchesInvalidation(entry({ companyIds: [1] }), {})).toBe(true);
  });
});

describe("read microcache key and etag", () => {
  it("builds keys from the full session and falls back for anonymous requests", () => {
    const full = buildReadMicrocacheKey(
      fakeReq("/api/factory/payrolls/preview", {
        method: "POST",
        body: { b: 1, a: [2] },
        headers: { "x-client-date": "2026-01-02", cookie: "factory_catalog_language=fr" },
        session: {
          userId: "u1",
          currentCompanyId: 7,
          factoryCompanyId: 8,
          currentRole: "Admin",
          currentLocationId: 3,
          currentPOSStation: "S1",
        },
      })
    );
    expect(full).toBe('POST|/api/factory/payrolls/preview|2026-01-02|fr|{"a":[2],"b":1}|u1|7|8|Admin|3|S1');

    const anonymous = buildReadMicrocacheKey(
      fakeReq("/api/factory/payrolls/preview", { method: "POST", session: undefined })
    );
    expect(anonymous).toBe("POST|/api/factory/payrolls/preview|none|en|null|anonymous|none|none|none|none|none");
    expect(buildReadMicrocacheKey(fakeReq("/api/stock-items", { session: {} }))).toBe(
      "GET|/api/stock-items|none|none||anonymous|none|none|none|none|none"
    );
  });

  it("matches etags by exact value or wildcard only", () => {
    const etag = makeEtag("hello");
    expect(etag).toMatch(/^W\/"5-/);
    expect(etagMatches(undefined, etag)).toBe(false);
    expect(etagMatches(`"other", ${etag}`, etag)).toBe(true);
    expect(etagMatches("*", etag)).toBe(true);
    expect(etagMatches('"other"', etag)).toBe(false);
  });
});
