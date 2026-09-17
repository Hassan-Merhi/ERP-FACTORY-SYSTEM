import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const executeResults: unknown[] = [];
  const selectResults: unknown[][] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  return {
    db: {
      execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
      select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
    },
    executeResults,
    selectResults,
    adjustInventory: vi.fn(),
    writeDaybookEntry: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/inventoryHelper", () => ({ adjustInventory: harness.adjustInventory }));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: harness.writeDaybookEntry }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/queryResult", () => ({ resultRows: (value: any) => value?.rows ?? [] }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  desc: (column: unknown) => ({ type: "desc", column }),
  inArray: (column: unknown, values: unknown[]) => ({ type: "inArray", column, values }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  factoryCategories: { id: "cats.id", name: "cats.name", companyId: "cats.companyId" },
  factoryBaleProducts: {
    id: "products.id",
    name: "products.name",
    articleCode: "products.articleCode",
    categoryId: "products.categoryId",
    productionPrice: "products.productionPrice",
    companyId: "products.companyId",
  },
  factoryBales: { id: "bales.id" },
  stockItems: { id: "stockItems.id" },
  locations: { id: "locations.id" },
  factoryDaybookEntries: { id: "daybook.id" },
  factoryBaleWasteDispatches: { id: "waste.id", companyId: "waste.companyId", dispatchNumber: "waste.dispatchNumber" },
}));

import { registerEmployeeLedgerWasteRoutes } from "../server/routes/factory/employee-pos/employeeLedgerWasteRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.set(`${method} ${path}`, handlers.at(-1));
  const app: any = {
    get: register("GET"),
    post: register("POST"),
    patch: register("PATCH"),
    delete: register("DELETE"),
  };
  registerEmployeeLedgerWasteRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return { session: { currentCompanyId: 4 }, query: {}, params: {}, body: {}, ...overrides } as any;
}

function resHarness() {
  const headers = new Map<string, unknown>();
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    set: vi.fn((name: string, value: unknown) => {
      headers.set(name, value);
      return res;
    }),
    headers,
  };
  return res;
}

describe("factory bale ledger route behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.executeResults.splice(0);
    harness.selectResults.splice(0);
  });

  it("classifies physical, waste, sold, dispatched, pending, and stale bales into mutually exclusive ledger buckets", async () => {
    harness.executeResults.push(
      {
        rows: [
          {
            id: 1,
            productId: 1,
            productName: "Shirts",
            articleCode: "SH-1",
            status: "IN_STOCK",
            referenceNumber: "R1",
            weightKg: 40,
          },
          {
            id: 2,
            productId: 2,
            productName: "Wipers",
            articleCode: "WP-1",
            status: "IN_STOCK",
            referenceNumber: "R2",
            weightKg: 20,
          },
          { id: 3, productId: 1, status: "SOLD", referenceNumber: "R3", weightKg: 40 },
          { id: 4, productId: 1, status: "SOLD", referenceNumber: "R4", weightKg: 40 },
          { id: 5, productId: 1, status: "FINALIZED", referenceNumber: "R5", weightKg: 40 },
          { id: 6, productId: 2, status: "DISPATCHED", wasteDispatchId: 77, referenceNumber: "R6", weightKg: 20 },
          { id: 7, productId: 1, status: "RESERVED_FOR_ORDER", referenceNumber: "R7", weightKg: 40 },
          { id: 8, productId: 1, status: "IN_STOCK", referenceNumber: "R8", weightKg: 40 },
          { id: 9, productId: 1, status: "IN_STOCK", referenceNumber: "R9", weightKg: 40 },
          {
            id: 10,
            productId: null,
            productName: "Waste",
            articleCode: "HMD16001",
            status: "IN_STOCK",
            referenceNumber: "R10",
            weightKg: 15,
          },
        ],
      },
      { rows: [{ baleId: 3 }, { baleId: 8 }] },
      { rows: [{ baleId: 9 }] }
    );
    harness.selectResults.push(
      [
        { id: 1, name: "Shirts", articleCode: "SH-1", categoryId: 10, productionPrice: "10" },
        { id: 2, name: "Wipers", articleCode: "WP-1", categoryId: 20, productionPrice: "5" },
      ],
      [
        { id: 10, name: "Clothing" },
        { id: 20, name: "Wiper Waste" },
      ]
    );

    const res = resHarness();
    await routes.get("GET /api/factory/bale-ledger")!(req(), res);

    expect(res.headers.get("Cache-Control")).toBe("private, max-age=120");
    expect(res.body.currentStock).toEqual([
      expect.objectContaining({ productName: "Shirts", baleCount: 1, totalWeightKg: 40, totalCost: 10 }),
    ]);
    expect(res.body.wasteStock).toEqual([
      expect.objectContaining({ productName: "Waste", baleCount: 1, totalWeightKg: 15 }),
      expect.objectContaining({ productName: "Wipers", baleCount: 1, totalWeightKg: 20, totalCost: 5 }),
    ]);
    expect(res.body.pendingLoading).toEqual([
      expect.objectContaining({ productName: "Shirts", baleCount: 3, totalWeightKg: 120, totalCost: 30 }),
    ]);
    expect(res.body.sold).toEqual([
      expect.objectContaining({ productName: "Shirts", baleCount: 3, totalWeightKg: 120, totalCost: 30 }),
    ]);
    expect(res.body.wasteDispatched).toEqual([
      expect.objectContaining({ productName: "Wipers", baleCount: 1, totalWeightKg: 20, totalCost: 5 }),
    ]);
    expect(res.body.totals.grand).toEqual({ baleCount: 10, totalWeightKg: 335, totalCost: 80 });
  });

  it("treats HMD16 article codes as waste even when there is no catalog product", async () => {
    harness.executeResults.push(
      {
        rows: [
          {
            id: 1,
            productId: null,
            productName: "Loose Waste",
            articleCode: "HMD16099",
            status: "IN_STOCK",
            weightKg: 12,
          },
        ],
      },
      { rows: [] },
      { rows: [] }
    );
    harness.selectResults.push([], []);
    const res = resHarness();
    await routes.get("GET /api/factory/bale-ledger")!(req(), res);
    expect(res.body.currentStock).toEqual([]);
    expect(res.body.wasteStock).toEqual([
      expect.objectContaining({ productName: "Loose Waste", articleCode: "HMD16099", baleCount: 1, totalWeightKg: 12 }),
    ]);
  });

  it("returns lazy bale details only for the requested ledger section and uses the catalog production price", async () => {
    harness.executeResults.push(
      {
        rows: [
          { id: 1, productId: 1, articleCode: "SH-1", status: "IN_STOCK", referenceNumber: "R1", weightKg: 40 },
          { id: 2, productId: 2, articleCode: "WP-1", status: "IN_STOCK", referenceNumber: "R2", weightKg: 20 },
          { id: 3, productId: 1, articleCode: "SH-1", status: "SOLD", referenceNumber: "R3", weightKg: 41 },
        ],
      },
      { rows: [{ baleId: 1 }] },
      { rows: [] }
    );
    harness.selectResults.push(
      [
        { id: 1, categoryId: 10, productionPrice: "12.50" },
        { id: 2, categoryId: 20, productionPrice: "4.25" },
      ],
      [
        { id: 10, name: "Clothing" },
        { id: 20, name: "Wiper Waste" },
      ]
    );

    const res = resHarness();
    await routes.get("GET /api/factory/bale-ledger/details")!(
      req({ query: { section: "pendingLoading", productId: "1" } }),
      res
    );

    expect(res.body).toEqual({
      baleDetails: [{ id: 1, ref: "R1", weightKg: 40, totalCost: 12.5 }],
    });
  });

  it("returns an empty waste-dispatch list immediately when no waste products exist", async () => {
    harness.selectResults.push([{ id: 20, name: "Wiper Waste" }], []);
    const res = resHarness();

    await routes.get("GET /api/factory/waste-dispatch/bales")!(req({ query: { search: "wipe" } }), res);

    expect(res.body).toEqual({ bales: [], categories: [{ id: 20, name: "Wiper Waste" }] });
    expect(harness.db.select).toHaveBeenCalledTimes(2);
  });

  it("groups waste history bales under their dispatch and leaves unmatched dispatches empty", async () => {
    harness.selectResults.push([
      { id: 7, dispatchNumber: "WD-0007" },
      { id: 8, dispatchNumber: "WD-0008" },
    ]);
    harness.executeResults.push({
      rows: [
        { id: 101, wasteDispatchId: 7, referenceNumber: "W-1" },
        { id: 102, wasteDispatchId: 7, referenceNumber: "W-2" },
      ],
    });
    const res = resHarness();

    await routes.get("GET /api/factory/waste-dispatch/history")!(req(), res);

    expect(res.body).toEqual([
      expect.objectContaining({ id: 7, bales: [expect.objectContaining({ id: 101 }), expect.objectContaining({ id: 102 })] }),
      expect.objectContaining({ id: 8, bales: [] }),
    ]);
  });

  it("requires a selected company and validates lazy-detail section names", async () => {
    const noCompany = resHarness();
    await routes.get("GET /api/factory/bale-ledger")!(req({ session: {} }), noCompany);
    expect(noCompany.statusCode).toBe(400);
    expect(noCompany.body).toEqual({ message: "No company selected" });

    const invalidSection = resHarness();
    await routes.get("GET /api/factory/bale-ledger/details")!(
      req({ query: { section: "other", productId: "1" } }),
      invalidSection
    );
    expect(invalidSection.statusCode).toBe(400);
    expect(invalidSection.body).toEqual({ message: "Invalid section" });
  });

  it("validates waste-dispatch delete identifiers and company-scoped existence", async () => {
    const invalid = resHarness();
    await routes.get("DELETE /api/factory/waste-dispatch/:id")!(req({ params: { id: "bad" } }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toEqual({ message: "Invalid dispatch id" });

    harness.selectResults.push([]);
    const missing = resHarness();
    await routes.get("DELETE /api/factory/waste-dispatch/:id")!(req({ params: { id: "77" } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ message: "Dispatch not found" });
  });

  it("validates waste-dispatch submit payloads before numbering or stock mutations", async () => {
    const noBales = resHarness();
    await routes.get("POST /api/factory/waste-dispatch/submit")!(
      req({ body: { baleIds: [], dispatchDate: "2026-09-17" } }),
      noBales
    );
    expect(noBales.statusCode).toBe(400);
    expect(noBales.body).toEqual({ message: "baleIds array is required" });

    const noDate = resHarness();
    await routes.get("POST /api/factory/waste-dispatch/submit")!(req({ body: { baleIds: [1] } }), noDate);
    expect(noDate.statusCode).toBe(400);
    expect(noDate.body).toEqual({ message: "dispatchDate is required" });
  });
});
