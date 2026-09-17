import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const selectErrors: unknown[] = [];
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const error = selectErrors.shift();
    const chain: any = {};
    for (const method of ["from", "where", "innerJoin", "leftJoin", "groupBy", "orderBy", "limit", "offset"]) {
      chain[method] = vi.fn(() => chain);
    }
    chain.then = (resolve: (value: unknown[]) => unknown, reject?: (error: unknown) => unknown) =>
      (error ? Promise.reject(error) : Promise.resolve(result)).then(resolve, reject);
    return chain;
  });

  const recordOperationalEvent = vi.fn();
  const loggerInfo = vi.fn();
  const loggerError = vi.fn();
  const jsonToSheet = vi.fn();
  const writeWorkbook = vi.fn(async () => Buffer.from("phase33g-xlsx"));

  return {
    selectResults,
    selectErrors,
    select,
    recordOperationalEvent,
    loggerInfo,
    loggerError,
    jsonToSheet,
    writeWorkbook,
  };
});

vi.mock("../server/db", () => ({ db: { select: harness.select } }));
vi.mock("../server/lib/operationalEvents", () => ({ recordOperationalEvent: harness.recordOperationalEvent }));
vi.mock("../server/lib/requestPerformanceContext", () => ({
  getRequestPerformanceMetrics: () => ({ dbQueryCount: 2, dbDurationMs: 7 }),
  runWithRequestPerformanceContext: (callback: () => void) => callback(),
}));
vi.mock("../server/lib/logger", () => ({
  logger: { info: harness.loggerInfo, error: harness.loggerError },
}));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../server/routes/_helpers", () => ({
  upload: {
    fields: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  },
}));
vi.mock("../server/excelHelper", () => ({
  readExcel: vi.fn(async () => ({ SheetNames: [], Sheets: {} })),
  sheetToJson: vi.fn(() => []),
  createWorkbook: vi.fn(() => ({})),
  jsonToSheet: harness.jsonToSheet,
  writeWorkbook: harness.writeWorkbook,
}));

import { clearERPContextCache, getCachedERPContext, getERPContext } from "../server/chat/erpContext";
import { registerAiValidationRoutes } from "../server/routes/aiValidationRoutes";
import { bandwidthDebugMiddleware, __bandwidthDebugTesting } from "../server/middleware/bandwidthDebug";
import {
  operationalBandwidthCompactResponse,
  operationalBandwidthWireInternals,
} from "../server/middleware/operationalBandwidthCompactResponse";
import {
  getBusinessSummary,
  getLowStockItems,
  getPricingHealth,
  getSalesForItem,
  getStockByLocation,
  searchCustomers,
  searchLedgerAccounts,
  searchStockItems,
  searchSuppliers,
  searchVouchers,
} from "../server/aiTools";

function queueSelectResults(...results: unknown[][]) {
  harness.selectResults.push(...results);
}

function responseHarness(statusCode = 200) {
  let body: unknown;
  const headers = new Map<string, unknown>();
  const res: any = {
    statusCode,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((payload: unknown) => {
      body = payload;
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.set(name.toLowerCase(), value);
      return res;
    }),
    getHeader: vi.fn((name: string) => headers.get(name.toLowerCase())),
    write: vi.fn(() => true),
    end: vi.fn(() => res),
  };
  return {
    res,
    headers,
    get body() {
      return body;
    },
  };
}

function validationHandler() {
  const registrations: Array<{ path: string; handlers: Array<(...args: any[]) => unknown> }> = [];
  const app = {
    post: (path: string, ...handlers: Array<(...args: any[]) => unknown>) => registrations.push({ path, handlers }),
  };
  registerAiValidationRoutes(app as any);
  const registration = registrations.find((entry) => entry.path === "/api/ai-validation/run");
  if (!registration) throw new Error("AI validation route was not registered");
  return registration.handlers[registration.handlers.length - 1];
}

async function invokeValidation(req: any) {
  const response = responseHarness();
  await validationHandler()(req, response.res);
  return response;
}

beforeEach(() => {
  harness.selectResults.length = 0;
  harness.selectErrors.length = 0;
  harness.select.mockClear();
  harness.recordOperationalEvent.mockClear();
  harness.loggerInfo.mockClear();
  harness.loggerError.mockClear();
  harness.jsonToSheet.mockClear();
  harness.writeWorkbook.mockClear();
  __bandwidthDebugTesting.clear();
  clearERPContextCache();
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.BANDWIDTH_DEBUG;
  delete process.env.BANDWIDTH_DEBUG_THRESHOLD_KB;
  delete process.env.BANDWIDTH_DEBUG_API_WINDOW_BUDGET_MB;
  delete process.env.BANDWIDTH_DEBUG_ENDPOINT_WINDOW_BUDGET_MB;
  delete process.env.BANDWIDTH_DEBUG_REPORT_INTERVAL_MS;
});

describe("Phase 33G — ERP context", () => {
  it("builds a safe zero-state context when a company has no ERP activity", async () => {
    const context = await getERPContext(77);

    expect(context.inventory).toEqual([]);
    expect(context.stockItems).toEqual([]);
    expect(context.salesSummary).toEqual({ totalSales: "0", count: 0 });
    expect(context.profitAnalysis).toEqual({ totalSales: "0", totalCost: "0", totalProfit: "0", itemsSold: 0 });
    expect(context.todaysSales).toMatchObject({ revenue: 0, cost: 0, profit: 0, transactionCount: 0, margin: "0" });
    expect(context.thisMonthSales).toMatchObject({ revenue: 0, cost: 0, profit: 0, transactionCount: 0, margin: "0" });
    expect(context.financialSummary).toEqual({
      totalPayables: 0,
      totalReceivables: 0,
      openPurchaseOrders: 0,
      pendingContainerSales: 0,
    });
    expect(context.lowStockAlerts).toEqual([]);
    expect(context.itemsToMarkdown).toEqual([]);
    expect(context.overdueContainers).toEqual([]);
    expect(context.recentSalesHistory).toEqual([]);
    expect(harness.select.mock.calls.length).toBeGreaterThan(15);
  });

  it("reuses a fresh company cache and reloads after explicit invalidation", async () => {
    const first = await getCachedERPContext(81);
    const callsAfterFirstLoad = harness.select.mock.calls.length;
    const second = await getCachedERPContext(81);

    expect(second).toBe(first);
    expect(harness.select).toHaveBeenCalledTimes(callsAfterFirstLoad);

    clearERPContextCache(81);
    const third = await getCachedERPContext(81);
    expect(third).not.toBe(first);
    expect(harness.select.mock.calls.length).toBeGreaterThan(callsAfterFirstLoad);
  });
});

describe("Phase 33G — AI validation routes", () => {
  it("rejects requests without company, validation type, or required upload", async () => {
    const noCompany = await invokeValidation({ session: {}, body: { validationType: "item_code_check" } });
    expect(noCompany.res.statusCode).toBe(400);
    expect(noCompany.body).toEqual({ message: "No company selected" });

    const noType = await invokeValidation({ session: { currentCompanyId: 1 }, body: {} });
    expect(noType.res.statusCode).toBe(400);
    expect(noType.body).toEqual({ message: "validationType is required" });

    const noFile = await invokeValidation({
      session: { currentCompanyId: 1 },
      body: { validationType: "item_code_check" },
    });
    expect(noFile.res.statusCode).toBe(400);
    expect(noFile.body).toEqual({ message: "A file is required for this validation type" });
  });

  it("classifies primary codes, aliases, fuzzy matches, missing codes, duplicates and blanks", async () => {
    queueSelectResults(
      [{ id: 10, code: "ABC123", name: "Primary Widget" }],
      [{ aliasCode: "ALT123", stockItemId: 10 }]
    );
    const csv = [
      "code,name",
      "ABC123,Primary",
      "ALT123,Alias",
      "ABC124,Fuzzy",
      "ZZZZZZ,Missing",
      "ABC123,Duplicate",
      ",Blank",
    ].join("\n");

    const response = await invokeValidation({
      session: { currentCompanyId: 4 },
      body: { validationType: "item_code_check" },
      files: { file1: [{ originalname: "codes.csv", buffer: Buffer.from(csv) }] },
    });
    const result = response.body as any;

    expect(response.res.statusCode).toBe(200);
    expect(result.summary).toMatchObject({
      totalChecked: 6,
      found: 2,
      missing: 1,
      duplicateInFile: 1,
      closeMatches: 1,
      codeColumn: "code",
    });
    expect(result.errors).toHaveLength(2);
    expect(result.warnings).toHaveLength(2);
    expect(result.suggestedFixes).toEqual([expect.objectContaining({ original: "ABC124", suggested: "abc123" })]);
    expect(result.cleanedExcel).toBe(Buffer.from("phase33g-xlsx").toString("base64"));
    expect(harness.jsonToSheet).toHaveBeenCalledWith(expect.anything(), expect.any(Array), "Validation Results");
  });

  it("detects normalized duplicate names and provides deterministic rename suggestions", async () => {
    const csv = ["name", "Widget", "Widget #2", "Widget - A", "Other"].join("\n");
    const response = await invokeValidation({
      session: { currentCompanyId: 4 },
      body: { validationType: "duplicate_name_check" },
      files: { file1: [{ originalname: "names.csv", buffer: Buffer.from(csv) }] },
    });
    const result = response.body as any;

    expect(result.summary).toMatchObject({
      totalChecked: 4,
      duplicateGroups: 1,
      duplicateItems: 3,
      nameColumn: "name",
    });
    expect(result.warnings).toHaveLength(1);
    expect(result.errors).toHaveLength(2);
    expect(result.suggestedFixes.map((fix: any) => fix.suggested)).toEqual(["Widget - A", "Widget - B"]);
    expect(result.cleanedExcel).toBeTruthy();
  });

  it("returns clear missing-column results and a structured stub for future validation types", async () => {
    const missingCode = await invokeValidation({
      session: { currentCompanyId: 2 },
      body: { validationType: "item_code_check" },
      files: { file1: [{ originalname: "bad.csv", buffer: Buffer.from("price\n10") }] },
    });
    expect((missingCode.body as any).summary.totalChecked).toBe(0);
    expect((missingCode.body as any).errors[0].message).toContain("No code column found");

    const future = await invokeValidation({
      session: { currentCompanyId: 2 },
      body: { validationType: "future_validator" },
    });
    expect(future.body).toMatchObject({
      validationType: "future_validator",
      cleanedExcel: null,
      warnings: [{ message: '"future_validator" validation is coming soon.' }],
    });
  });

  it("logs and returns unexpected validation failures", async () => {
    harness.selectErrors.push(new Error("database unavailable"), new Error("unused"));
    const response = await invokeValidation({
      session: { currentCompanyId: 9 },
      body: { validationType: "item_code_check" },
      files: { file1: [{ originalname: "codes.csv", buffer: Buffer.from("code\nABC123") }] },
    });

    expect(response.res.statusCode).toBe(500);
    expect(response.body).toEqual({ message: "database unavailable" });
    expect(harness.loggerError).toHaveBeenCalled();
  });
});

describe("Phase 33G — compact operational responses", () => {
  function compactRequest(path: string, profile?: string) {
    return {
      method: "GET",
      path,
      header: (name: string) => {
        const lower = name.toLowerCase();
        if (lower === "x-erp-compact-response") return "v1";
        if (lower === "x-erp-response-profile") return profile;
        return undefined;
      },
    } as any;
  }

  it("leaves non-negotiated traffic untouched", () => {
    const response = responseHarness();
    const originalJson = response.res.json;
    const next = vi.fn();
    operationalBandwidthCompactResponse(
      { method: "POST", path: "/api/factory/customer-proformas", header: () => "v1" } as any,
      response.res,
      next
    );
    expect(next).toHaveBeenCalledOnce();
    expect(response.res.json).toBe(originalJson);
  });

  it("compacts successful negotiated payloads with dictionary and row encoding", () => {
    const response = responseHarness();
    response.res.setHeader("Vary", "Accept-Encoding");
    const originalJson = response.res.json;
    operationalBandwidthCompactResponse(compactRequest("/api/factory/customer-proformas"), response.res, vi.fn());

    response.res.json([
      { id: 1, label: "Repeated long product name" },
      { id: 2, label: "Repeated long product name" },
      { id: 3, label: "Repeated long product name" },
    ]);

    expect(originalJson).toHaveBeenCalledOnce();
    const wire = originalJson.mock.calls[0][0] as any;
    expect(wire.__erpWire).toBe(1);
    expect(wire.d).toContain("Repeated long product name");
    expect(wire.v["~a"][0]).toEqual(["id", "label"]);
    expect(response.headers.get("x-erp-compact-response")).toBe("v1");
    expect(response.headers.get("vary")).toContain("Accept-Encoding");
    expect(response.headers.get("vary")).toContain("x-erp-compact-response");
  });

  it("preserves error responses and trims page-specific negotiated profiles", () => {
    const errorResponse = responseHarness(500);
    const errorJson = errorResponse.res.json;
    operationalBandwidthCompactResponse(compactRequest("/api/factory/customer-proformas"), errorResponse.res, vi.fn());
    errorResponse.res.json({ message: "failed" });
    expect(errorJson).toHaveBeenCalledWith({ message: "failed" });
    expect(errorResponse.headers.has("x-erp-compact-response")).toBe(false);

    expect(
      operationalBandwidthWireInternals.preparePayload(
        compactRequest("/api/factory/location-inventory/12", "location-inventory-summary-v1"),
        [{ id: 1, referenceNumbers: ["A", "B"], quantity: 2 }]
      )
    ).toEqual([{ id: 1, quantity: 2 }]);

    expect(
      operationalBandwidthWireInternals.preparePayload(
        compactRequest("/api/factory/customer-orders/22", "loading-order-state-v1"),
        { id: 22, lines: [{ id: 1 }], charges: [{ id: 2 }], bales: [{ id: 3 }] }
      )
    ).toEqual({ id: 22, bales: [{ id: 3 }] });
  });

  it("projects waste dispatch page and history payloads without unrelated fields", () => {
    const balePayload = operationalBandwidthWireInternals.preparePayload(
      compactRequest("/api/factory/waste-dispatch/bales", "waste-dispatch-page-v1"),
      {
        bales: [
          {
            id: 1,
            referenceNumber: "R1",
            productName: "P",
            categoryName: "C",
            locationName: "L",
            weightKg: 5,
            totalCost: 7,
            secret: "drop",
          },
        ],
        categories: ["unused"],
      }
    ) as any;
    expect(balePayload).toEqual({
      bales: [
        {
          id: 1,
          referenceNumber: "R1",
          productName: "P",
          categoryName: "C",
          locationName: "L",
          weightKg: 5,
          totalCost: 7,
        },
      ],
    });

    const history = operationalBandwidthWireInternals.preparePayload(
      compactRequest("/api/factory/waste-dispatch/history", "waste-dispatch-page-v1"),
      [
        {
          id: 9,
          dispatchNumber: "D9",
          dispatchDate: "2026-09-17",
          totalBales: 1,
          totalWeightKg: 5,
          totalCostWrittenOff: 7,
          internal: "drop",
          bales: [{ id: 1, referenceNumber: "R1", productName: "P", weightKg: 5, totalCost: 7, categoryName: "drop" }],
        },
      ]
    );
    expect(history).toEqual([
      {
        id: 9,
        dispatchNumber: "D9",
        dispatchDate: "2026-09-17",
        totalBales: 1,
        totalWeightKg: 5,
        totalCostWrittenOff: 7,
        bales: [{ id: 1, referenceNumber: "R1", productName: "P", weightKg: 5, totalCost: 7 }],
      },
    ]);
  });

  it("normalizes JSON values exactly like res.json and recognizes compactable paths", () => {
    expect(operationalBandwidthWireInternals.shouldCompactPath("/api/factory/location-inventory/12")).toBe(true);
    expect(operationalBandwidthWireInternals.shouldCompactPath("/api/factory/location-inventory/not-a-number")).toBe(
      false
    );
    expect(
      operationalBandwidthWireInternals.shouldCompactPath("/api/factory/customer-orders/8/verification-summary")
    ).toBe(true);
    expect(
      operationalBandwidthWireInternals.normalizeLikeResJson({ keep: 1, drop: undefined, arr: [undefined] })
    ).toEqual({ keep: 1, arr: [null] });
    expect(operationalBandwidthWireInternals.DICT_TOKEN.test("~z")).toBe(true);
    expect(operationalBandwidthWireInternals.DICT_TOKEN.test("plain")).toBe(false);
  });
});

describe("Phase 33G — bandwidth diagnostics", () => {
  it("normalizes route ids, cache outcomes, contexts and thresholds", () => {
    expect(
      __bandwidthDebugTesting.normalizePath({ route: { path: "/:id" }, baseUrl: "/api/items", path: "/ignored" } as any)
    ).toBe("/api/items/:id");
    expect(
      __bandwidthDebugTesting.normalizePath({ path: "/api/items/123/550e8400-e29b-41d4-a716-446655440000" } as any)
    ).toBe("/api/items/:id/:id");
    expect(__bandwidthDebugTesting.isApiPath("/api")).toBe(true);
    expect(__bandwidthDebugTesting.isStaticAsset("/assets/main-ABCdef12.css")).toBe(true);
    expect(__bandwidthDebugTesting.classifyCacheOutcome(200, "BYPASS")).toBe("miss");
    expect(__bandwidthDebugTesting.classifyCacheOutcome(200, "other")).toBe("unknown");
    expect(__bandwidthDebugTesting.requestCompanyContext({ session: { currentCompanyId: 7 } } as any)).toBe("7");
    expect(
      __bandwidthDebugTesting.requestCompanyContext({ session: { currentCompanyId: 7, factoryCompanyId: 8 } } as any)
    ).toBe("8");
    expect(
      __bandwidthDebugTesting.requestPageContext({
        get: (name: string) => (name === "x-erp-page" ? "/factory/live" : undefined),
      } as any)
    ).toBe("/factory/live");
    expect(
      __bandwidthDebugTesting.requestPageContext({
        get: (name: string) => (name === "referer" ? "https://erp.test/accounts?id=2" : undefined),
      } as any)
    ).toBe("/accounts");
  });

  it("records middleware bytes, DB metrics, cache outcome, context and budget violations", () => {
    process.env.BANDWIDTH_DEBUG = "true";
    process.env.BANDWIDTH_DEBUG_THRESHOLD_KB = "0.001";
    process.env.BANDWIDTH_DEBUG_API_WINDOW_BUDGET_MB = "0.000001";
    process.env.BANDWIDTH_DEBUG_ENDPOINT_WINDOW_BUDGET_MB = "0.000001";
    process.env.BANDWIDTH_DEBUG_REPORT_INTERVAL_MS = "600000";

    const response = responseHarness(200);
    response.res.setHeader("X-ERP-Read-Cache", "HIT");
    const request = {
      method: "GET",
      path: "/api/items/123",
      route: undefined,
      baseUrl: "",
      session: { currentCompanyId: 5 },
      get: (name: string) => (name.toLowerCase() === "x-erp-page" ? "/inventory" : undefined),
    } as any;
    const next = vi.fn();

    bandwidthDebugMiddleware(request, response.res, next);
    expect(next).toHaveBeenCalledOnce();
    response.res.write("abcdef");
    response.res.end("ghijkl");

    expect(harness.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        code: "large_http_response",
        responseBytes: 12,
        dbQueryCount: 2,
        dbDurationMs: 7,
        cacheOutcome: "hit",
        companyContext: "5",
        pageContext: "/inventory",
      })
    );

    __bandwidthDebugTesting.emitRanking();
    const snapshot = __bandwidthDebugTesting.getBandwidthDiagnosticSnapshot();
    expect(snapshot.ranked[0]).toMatchObject({
      method: "GET",
      path: "/api/items/:id",
      requests: 1,
      totalResponseBytes: 12,
      cacheHits: 1,
      companyContexts: ["5"],
      pageContexts: ["/inventory"],
    });
    expect(snapshot.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining(["api_bandwidth_budget_exceeded", "api_endpoint_bandwidth_budget_exceeded"])
    );
    expect(harness.recordOperationalEvent).toHaveBeenCalledWith(
      expect.objectContaining({ code: "endpoint_performance_ranking" })
    );
  });

  it("does nothing when diagnostics are disabled and safely clears non-ranked paths", () => {
    const response = responseHarness();
    const next = vi.fn();
    bandwidthDebugMiddleware({ method: "GET", path: "/health", get: () => undefined } as any, response.res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(response.res.write).toBe(response.res.write);
    __bandwidthDebugTesting.emitRanking();
    expect(__bandwidthDebugTesting.getBandwidthDiagnosticSnapshot().generatedAt).toBeNull();
  });
});

describe("Phase 33G — AI tools", () => {
  it("searches stock and reports profitable, break-even and losing inventory", async () => {
    queueSelectResults(
      [
        { id: 1, code: "A", name: "Alpha", sellingPrice: "8", reorderLevel: "2" },
        { id: 2, code: "B", name: "Beta", sellingPrice: "10", reorderLevel: "1" },
        { id: 3, code: "C", name: "Gamma", sellingPrice: "12", reorderLevel: "0" },
      ],
      [
        { stockItemId: 1, totalQty: "3", totalValue: "30", avgRate: "10" },
        { stockItemId: 2, totalQty: "2", totalValue: "20", avgRate: "10" },
        { stockItemId: 3, totalQty: "5", totalValue: "45", avgRate: "9" },
      ]
    );
    const rows = await searchStockItems(3, "Alpha + Beta", 10);
    expect(rows.map((row) => row.pricingStatus)).toEqual(["LOSING", "BREAK_EVEN", "PROFITABLE"]);
    expect(rows[0]).toMatchObject({ totalQty: "3.000", avgCost: "10.00", sellingPrice: "8.00" });
  });

  it("maps stock by location and filters zero quantities", async () => {
    queueSelectResults(
      [
        { locationId: 1, quantity: "3", averageRate: "4.5", totalValue: "13.5" },
        { locationId: 2, quantity: "0", averageRate: "5", totalValue: "0" },
        { locationId: null, quantity: "2", averageRate: "6", totalValue: "12" },
      ],
      [
        { id: 1, name: "Main", code: "M" },
        { id: 2, name: "Overflow", code: "O" },
      ]
    );
    const rows = await getStockByLocation(3, 99);
    expect(rows).toEqual([
      { locationId: 1, location: "Main (M)", quantity: "3.000", avgCost: "4.50", totalValue: "13.50" },
      { locationId: null, location: "Unknown", quantity: "2.000", avgCost: "6.00", totalValue: "12.00" },
    ]);
  });

  it("formats supplier, customer, ledger and voucher searches", async () => {
    queueSelectResults([{ id: 1, code: null, legalName: null, phone: null, email: null, openingBalance: "12.5" }]);
    expect(await searchSuppliers(4, "acme")).toEqual([
      { id: 1, code: "", name: "Unknown", phone: "", email: "", openingBalance: "12.50" },
    ]);

    queueSelectResults([{ id: 2, code: "C2", legalName: "Customer Two", phone: null }]);
    expect(await searchCustomers(4, "two")).toEqual([{ id: 2, code: "C2", name: "Customer Two", phone: "" }]);

    queueSelectResults([
      { id: 3, code: "100", name: "Cash", accountType: "Asset", openingBalance: "4", openingBalanceSide: null },
    ]);
    expect(await searchLedgerAccounts(4, "cash")).toEqual([
      { id: 3, code: "100", name: "Cash", accountType: "Asset", openingBalance: "4.00", openingBalanceSide: "Dr" },
    ]);

    queueSelectResults([
      {
        id: 4,
        voucherNumber: "V4",
        voucherType: "Receipt",
        voucherDate: "2026-09-17",
        totalAmount: "7.2",
        description: null,
      },
    ]);
    expect(await searchVouchers(4, "V4")).toEqual([
      { id: 4, number: "V4", type: "Receipt", date: "2026-09-17", amount: "7.20", description: "" },
    ]);
  });

  it("ranks low-stock alerts and pricing-health losses", async () => {
    queueSelectResults(
      [
        { id: 1, code: "A", name: "Out", reorderLevel: "5" },
        { id: 2, code: "B", name: "Low", reorderLevel: "5" },
        { id: 3, code: "C", name: "Healthy", reorderLevel: "5" },
      ],
      [
        { stockItemId: 1, totalQty: "0" },
        { stockItemId: 2, totalQty: "2" },
        { stockItemId: 3, totalQty: "8" },
      ]
    );
    expect(await getLowStockItems(1)).toEqual([
      { id: 1, code: "A", name: "Out", qty: "0.000", reorderLevel: "5.00", status: "OUT_OF_STOCK" },
      { id: 2, code: "B", name: "Low", qty: "2.000", reorderLevel: "5.00", status: "LOW_STOCK" },
    ]);

    queueSelectResults(
      [
        { id: 1, code: "A", name: "Loss", sellingPrice: "8" },
        { id: 2, code: "B", name: "Even", sellingPrice: "10" },
        { id: 3, code: "C", name: "Profit", sellingPrice: "14" },
        { id: 4, code: "D", name: "Unknown", sellingPrice: "9" },
      ],
      [
        { stockItemId: 1, totalQty: "3", avgRate: "10", totalValue: "30" },
        { stockItemId: 2, totalQty: "2", avgRate: "10", totalValue: "20" },
        { stockItemId: 3, totalQty: "4", avgRate: "10", totalValue: "40" },
      ]
    );
    const pricing = await getPricingHealth(1);
    expect(pricing.map((row) => row.status)).toEqual(["LOSING", "BREAK_EVEN", "PROFITABLE"]);
    expect(pricing[0]).toMatchObject({ priceGap: "-2.00", potentialLoss: "6.00" });
  });

  it("formats item sales and summarizes current business activity", async () => {
    queueSelectResults([
      {
        voucherNumber: "S1",
        voucherDate: "2026-09-17",
        quantity: "2.5",
        sellingPrice: "12",
        costPrice: "8",
        totalSales: "30",
        profit: "10",
      },
    ]);
    expect(await getSalesForItem(1, 4)).toEqual([
      {
        voucherNumber: "S1",
        date: "2026-09-17",
        qty: "2.500",
        sellingPrice: "12.00",
        costPrice: "8.00",
        totalSales: "30.00",
        profit: "10.00",
      },
    ]);

    queueSelectResults(
      [{ revenue: "100", cost: "70", profit: "30", transactionCount: 4, unitsSold: "9" }],
      [{ revenue: "250", cost: "180", profit: "70", transactionCount: 8, unitsSold: "20" }],
      [{ count: 3 }],
      [{ stockItemId: 1, itemName: null, itemCode: null, totalRevenue: "90", totalProfit: "12", totalQty: "6" }]
    );
    const summary = await getBusinessSummary(1);
    expect(summary.today).toMatchObject({
      revenue: "100.00",
      cost: "70.00",
      profit: "30.00",
      margin: "30.0%",
      transactions: 4,
      unitsSold: "9.00",
    });
    expect(summary.thisMonth).toMatchObject({ revenue: "250.00", profit: "70.00", margin: "28.0%" });
    expect(summary.openPurchaseOrders).toBe(3);
    expect(summary.topItemsThisMonth).toEqual([
      { name: "Unknown", code: "", revenue: "90.00", profit: "12.00", qty: "6.00" },
    ]);
  });
});
