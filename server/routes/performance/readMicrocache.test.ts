import { describe, expect, it, vi } from "vitest";
import {
  buildReadMicrocacheKey,
  createReadMicrocacheMiddleware,
  getReadMicrocacheStats,
  READ_MICROCACHE_PATHS,
  READ_MICROCACHE_TTL_MS,
} from "./readMicrocache";

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/api/accounts/all",
    originalUrl: "/api/accounts/all?startDate=2026-07-01",
    headers: {},
    query: {},
    body: undefined,
    session: {
      userId: 7,
      currentCompanyId: 3,
      factoryCompanyId: null,
      currentRole: "Admin",
      currentLocationId: 2,
      currentPOSStation: 1,
    },
    ...overrides,
  };
}

function makeResponse(statusCode = 200) {
  const listeners = new Map<string, (() => void)[]>();
  return {
    statusCode,
    sentBody: undefined as unknown,
    jsonBody: undefined as unknown,
    ended: false,
    headers: {} as Record<string, string>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    setHeader(name: string, value: string) {
      this.headers[name] = value;
      return this;
    },
    getHeaders() {
      return { ...this.headers };
    },
    send(body: unknown) {
      this.sentBody = body;
      return this;
    },
    json(body: unknown) {
      this.jsonBody = body;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
    once(event: string, listener: () => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    emit(event: string) {
      for (const listener of listeners.get(event) ?? []) listener();
      listeners.delete(event);
      return this;
    },
  };
}

function storeJson(middleware: unknown, request: unknown, response: unknown, body: unknown) {
  middleware(request, response, () => response.json(body));
}

describe("Phase 7C read microcache", () => {
  it("covers the current production bandwidth hotspots", () => {
    const expectedPaths = [
      "/api/sales-report",
      "/api/location-summary",
      "/api/reports/stock-movement",
      "/api/factory/payrolls",
      "/api/factory/payrolls/preview",
      "/api/accounts/all",
      "/api/factory/raw-stock",
      "/api/factory/mix-batches",
      "/api/factory/bale-ledger",
      "/api/factory/containers",
      "/api/factory/bale-products",
      "/api/factory/workers",
      "/api/ledger-accounts",
      "/api/stock-items/light",
      "/api/locations",
      "/api/suppliers",
    ];

    for (const path of expectedPaths) expect(READ_MICROCACHE_PATHS.has(path)).toBe(true);
    expect(READ_MICROCACHE_PATHS.has("/api/pos/drafts")).toBe(false);
    expect(READ_MICROCACHE_TTL_MS.get("/api/sales-report")).toBe(120_000);
    expect(READ_MICROCACHE_TTL_MS.get("/api/factory/payrolls")).toBe(120_000);
    expect(READ_MICROCACHE_TTL_MS.get("/api/factory/bale-products")).toBe(300_000);
  });

  it("isolates cache keys by user, company, role, location, station, query, and client date", () => {
    const base = buildReadMicrocacheKey(makeRequest());
    const differentQuery = buildReadMicrocacheKey(
      makeRequest({ originalUrl: "/api/accounts/all?startDate=2026-07-02" })
    );
    const differentDate = buildReadMicrocacheKey(makeRequest({ headers: { "x-client-date": "2026-07-31" } }));
    const differentUser = buildReadMicrocacheKey(makeRequest({ session: { userId: 8, currentCompanyId: 3 } }));
    const differentCompany = buildReadMicrocacheKey(makeRequest({ session: { userId: 7, currentCompanyId: 4 } }));

    expect(differentQuery).not.toBe(base);
    expect(differentDate).not.toBe(base);
    expect(differentUser).not.toBe(base);
    expect(differentCompany).not.toBe(base);
  });

  it("serves a successful repeated JSON read from the short cache", () => {
    let currentTime = 1_000;
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 1_000, now: () => currentTime });
    const request = makeRequest();
    const firstResponse = makeResponse();
    storeJson(middleware, request, firstResponse, { total: 12 });

    expect(firstResponse.jsonBody).toEqual({ total: 12 });
    expect(firstResponse.headers["Cache-Control"]).toBe("private, no-cache, must-revalidate");
    expect(firstResponse.headers.ETag).toBeTruthy();

    currentTime = 1_500;
    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.sentBody).toBe(JSON.stringify({ total: 12 }));
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
    expect(getReadMicrocacheStats().hits).toBe(1);
  });

  it("preserves pagination metadata headers on cache hits", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest();
    const firstResponse = makeResponse();
    firstResponse.setHeader("X-Total-Count", "42");
    firstResponse.setHeader("X-Page", "2");
    firstResponse.setHeader("X-Page-Size", "10");
    firstResponse.setHeader("X-Total-Pages", "5");
    firstResponse.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");
    storeJson(middleware, request, firstResponse, { items: [] });

    const secondResponse = makeResponse();
    middleware(request, secondResponse, vi.fn());

    expect(secondResponse.headers["X-Total-Count"]).toBe("42");
    expect(secondResponse.headers["X-Page"]).toBe("2");
    expect(secondResponse.headers["X-Page-Size"]).toBe("10");
    expect(secondResponse.headers["X-Total-Pages"]).toBe("5");
    expect(secondResponse.headers["Access-Control-Expose-Headers"]).toContain("X-Total-Count");
  });

  it("does not treat service-worker no-store semantics as an ERP-cache bypass", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest({ headers: { "cache-control": "no-store" } });
    storeJson(middleware, request, makeResponse(), { total: 12 });

    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("returns 304 when the browser revalidates an unchanged cached response", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const firstResponse = makeResponse();
    storeJson(middleware, makeRequest(), firstResponse, { total: 12 });

    const secondResponse = makeResponse();
    const request = makeRequest({ headers: { "if-none-match": firstResponse.headers.ETag } });
    middleware(request, secondResponse, vi.fn());

    expect(secondResponse.statusCode).toBe(304);
    expect(secondResponse.ended).toBe(true);
    expect(secondResponse.sentBody).toBeUndefined();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("REVALIDATED");
  });

  it("caches payroll preview POSTs by stable request body", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const firstRequest = makeRequest({
      method: "POST",
      path: "/api/factory/payrolls/preview",
      originalUrl: "/api/factory/payrolls/preview",
      body: { periodEnd: "2026-07-31", periodStart: "2026-07-01" },
    });
    storeJson(middleware, firstRequest, makeResponse(), { workers: 12 });

    const secondRequest = makeRequest({
      method: "POST",
      path: "/api/factory/payrolls/preview",
      originalUrl: "/api/factory/payrolls/preview",
      body: { periodStart: "2026-07-01", periodEnd: "2026-07-31" },
    });
    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(secondRequest, secondResponse, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
    expect(secondResponse.sentBody).toBe(JSON.stringify({ workers: 12 }));
  });

  it("supports dynamic heavy read paths", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest({
      path: "/api/locations/12/inventory",
      originalUrl: "/api/locations/12/inventory?profile=combined",
    });
    storeJson(middleware, request, makeResponse(), { rows: 10 });

    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("caches compact location inventory on the same scoped path family", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest({
      path: "/api/locations/12/inventory/light",
      originalUrl: "/api/locations/12/inventory/light",
    });
    storeJson(middleware, request, makeResponse(), [{ stockItemId: 4, quantity: "12" }]);

    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);

    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("does not cache failed responses or requests outside the allowlist", () => {
    const middleware = createReadMicrocacheMiddleware();
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(500), { message: "failed" });

    const retryNext = vi.fn();
    middleware(request, makeResponse(), retryNext);
    expect(retryNext).toHaveBeenCalledOnce();

    const unrelatedRequest = makeRequest({ path: "/api/vouchers", originalUrl: "/api/vouchers" });
    const unrelatedNext = vi.fn();
    middleware(unrelatedRequest, makeResponse(), unrelatedNext);
    expect(unrelatedNext).toHaveBeenCalledOnce();
  });

  it("expires entries after the configured TTL", () => {
    let currentTime = 10;
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5, now: () => currentTime });
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(), { ok: true });

    currentTime = 16;
    const next = vi.fn();
    middleware(request, makeResponse(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it("clears cached reads only after a successful authenticated business request", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(), { ok: true });

    const writeRequest = makeRequest({
      method: "POST",
      path: "/api/vouchers",
      originalUrl: "/api/vouchers",
    });
    const writeResponse = makeResponse(200);
    const writeNext = vi.fn();
    middleware(writeRequest, writeResponse, writeNext);
    expect(writeNext).toHaveBeenCalledOnce();

    const beforeFinishNext = vi.fn();
    middleware(request, makeResponse(), beforeFinishNext);
    expect(beforeFinishNext).not.toHaveBeenCalled();

    writeResponse.emit("finish");
    const afterFinishNext = vi.fn();
    middleware(request, makeResponse(), afterFinishNext);
    expect(afterFinishNext).toHaveBeenCalledOnce();
  });

  it("invalidates cached reads when an authenticated write response closes early", () => {
    const publishInvalidation = vi.fn(async () => undefined);
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000, publishInvalidation });
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(), { ok: true });

    const writeRequest = makeRequest({
      method: "POST",
      path: "/api/vouchers",
      originalUrl: "/api/vouchers",
    });
    const writeResponse = makeResponse(200);
    middleware(writeRequest, writeResponse, vi.fn());
    writeResponse.emit("close");

    expect(publishInvalidation).toHaveBeenCalledOnce();
    expect(publishInvalidation).toHaveBeenCalledWith({
      companyIds: [3],
      topics: ["accounting"],
    });
    const readNext = vi.fn();
    middleware(request, makeResponse(), readNext);
    expect(readNext).toHaveBeenCalledOnce();
  });

  it("does not let unauthenticated or failed writes flush the cache", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(), { ok: true });

    const anonymousRequest = makeRequest({
      method: "POST",
      path: "/api/vouchers",
      originalUrl: "/api/vouchers",
      session: {},
    });
    const anonymousResponse = makeResponse(200);
    middleware(anonymousRequest, anonymousResponse, vi.fn());
    anonymousResponse.emit("finish");

    const failedRequest = makeRequest({
      method: "POST",
      path: "/api/vouchers",
      originalUrl: "/api/vouchers",
    });
    const failedResponse = makeResponse(403);
    middleware(failedRequest, failedResponse, vi.fn());
    failedResponse.emit("finish");

    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("preserves business caches across POS autosave and presence heartbeat writes", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const request = makeRequest();
    storeJson(middleware, request, makeResponse(), { ok: true });

    const draftRequest = makeRequest({
      method: "PATCH",
      path: "/api/pos/drafts/42",
      originalUrl: "/api/pos/drafts/42",
    });
    const presenceRequest = makeRequest({
      method: "PATCH",
      path: "/api/user-presence",
      originalUrl: "/api/user-presence",
    });
    middleware(draftRequest, makeResponse(), vi.fn());
    middleware(presenceRequest, makeResponse(), vi.fn());

    const secondResponse = makeResponse();
    const secondNext = vi.fn();
    middleware(request, secondResponse, secondNext);
    expect(secondNext).not.toHaveBeenCalled();
    expect(secondResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("keeps unrelated topic caches warm after a targeted write", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const accountingRequest = makeRequest({
      path: "/api/accounts/all",
      originalUrl: "/api/accounts/all",
    });
    const inventoryRequest = makeRequest({
      path: "/api/stock-items/light",
      originalUrl: "/api/stock-items/light",
    });

    storeJson(middleware, accountingRequest, makeResponse(), { accounts: 4 });
    storeJson(middleware, inventoryRequest, makeResponse(), [{ id: 1 }]);

    const writeResponse = makeResponse(200);
    middleware(
      makeRequest({ method: "POST", path: "/api/vouchers", originalUrl: "/api/vouchers" }),
      writeResponse,
      vi.fn()
    );
    writeResponse.emit("finish");

    const accountingNext = vi.fn();
    middleware(accountingRequest, makeResponse(), accountingNext);
    expect(accountingNext).toHaveBeenCalledOnce();

    const inventoryResponse = makeResponse();
    const inventoryNext = vi.fn();
    middleware(inventoryRequest, inventoryResponse, inventoryNext);
    expect(inventoryNext).not.toHaveBeenCalled();
    expect(inventoryResponse.headers["X-ERP-Read-Cache"]).toBe("HIT");

    expect(getReadMicrocacheStats()).toMatchObject({
      targetedInvalidations: 1,
      blanketInvalidations: 0,
      invalidatedEntries: 1,
    });
  });

  it("keeps other companies warm when one company writes", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const company3 = makeRequest({
      path: "/api/accounts/all",
      originalUrl: "/api/accounts/all",
      session: { userId: 7, currentCompanyId: 3, currentRole: "Admin" },
    });
    const company4 = makeRequest({
      path: "/api/accounts/all",
      originalUrl: "/api/accounts/all",
      session: { userId: 7, currentCompanyId: 4, currentRole: "Admin" },
    });

    storeJson(middleware, company3, makeResponse(), { company: 3 });
    storeJson(middleware, company4, makeResponse(), { company: 4 });

    const writeResponse = makeResponse(200);
    middleware(
      makeRequest({
        method: "POST",
        path: "/api/vouchers",
        originalUrl: "/api/vouchers",
        session: { userId: 7, currentCompanyId: 3, currentRole: "Admin" },
      }),
      writeResponse,
      vi.fn()
    );
    writeResponse.emit("finish");

    const company3Next = vi.fn();
    middleware(company3, makeResponse(), company3Next);
    expect(company3Next).toHaveBeenCalledOnce();

    const company4Response = makeResponse();
    const company4Next = vi.fn();
    middleware(company4, company4Response, company4Next);
    expect(company4Next).not.toHaveBeenCalled();
    expect(company4Response.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("keeps explicitly different inventory locations warm", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const location3 = makeRequest({
      path: "/api/locations/3/inventory/light",
      originalUrl: "/api/locations/3/inventory/light",
    });
    const location4 = makeRequest({
      path: "/api/locations/4/inventory/light",
      originalUrl: "/api/locations/4/inventory/light",
    });

    storeJson(middleware, location3, makeResponse(), [{ stockItemId: 1, quantity: "2" }]);
    storeJson(middleware, location4, makeResponse(), [{ stockItemId: 1, quantity: "5" }]);

    const writeResponse = makeResponse(200);
    middleware(
      makeRequest({
        method: "POST",
        path: "/api/locations/3/inventory/adjust",
        originalUrl: "/api/locations/3/inventory/adjust",
      }),
      writeResponse,
      vi.fn()
    );
    writeResponse.emit("finish");

    const location3Next = vi.fn();
    middleware(location3, makeResponse(), location3Next);
    expect(location3Next).toHaveBeenCalledOnce();

    const location4Response = makeResponse();
    const location4Next = vi.fn();
    middleware(location4, location4Response, location4Next);
    expect(location4Next).not.toHaveBeenCalled();
    expect(location4Response.headers["X-ERP-Read-Cache"]).toBe("HIT");
  });

  it("keeps unknown write families on the safe blanket fallback", () => {
    const middleware = createReadMicrocacheMiddleware({ ttlMs: 5_000 });
    const company3 = makeRequest({
      path: "/api/accounts/all",
      originalUrl: "/api/accounts/all",
      session: { userId: 7, currentCompanyId: 3, currentRole: "Admin" },
    });
    const company4 = makeRequest({
      path: "/api/accounts/all",
      originalUrl: "/api/accounts/all",
      session: { userId: 7, currentCompanyId: 4, currentRole: "Admin" },
    });

    storeJson(middleware, company3, makeResponse(), { company: 3 });
    storeJson(middleware, company4, makeResponse(), { company: 4 });

    const writeResponse = makeResponse(200);
    middleware(
      makeRequest({
        method: "POST",
        path: "/api/admin/unclassified-write",
        originalUrl: "/api/admin/unclassified-write",
        session: { userId: 7, currentCompanyId: 3, currentRole: "Admin" },
      }),
      writeResponse,
      vi.fn()
    );
    writeResponse.emit("finish");

    const company3Next = vi.fn();
    const company4Next = vi.fn();
    middleware(company3, makeResponse(), company3Next);
    middleware(company4, makeResponse(), company4Next);

    expect(company3Next).toHaveBeenCalledOnce();
    expect(company4Next).toHaveBeenCalledOnce();
    expect(getReadMicrocacheStats()).toMatchObject({
      targetedInvalidations: 0,
      blanketInvalidations: 1,
      invalidatedEntries: 2,
    });
  });
});
