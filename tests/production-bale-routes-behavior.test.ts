import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const storage = {
    getAllProductionBales: vi.fn(),
    getProductionBaleByBarcode: vi.fn(),
    getMixBatchById: vi.fn(),
  };
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const db: any = {
    select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
    transaction: vi.fn(),
  };
  return { db, selectResults, storage };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/routes/_helpers", () => ({ upload: { single: () => (_req: any, _res: any, next: any) => next() } }));
vi.mock("../server/excelHelper", () => ({ readExcel: vi.fn(), sheetToJson: vi.fn() }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  or: (...conditions: unknown[]) => ({ type: "or", conditions }),
  desc: (column: unknown) => ({ type: "desc", column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  baleProducts: { id: "baleProducts.id" },
  baleSequences: { id: "baleSequences.id", companyId: "baleSequences.companyId" },
  mixBatches: { id: "mixBatches.id" },
  pressingBatches: {
    id: "pressingBatches.id",
    companyId: "pressingBatches.companyId",
    createdAt: "pressingBatches.createdAt",
  },
  productionBales: {
    id: "productionBales.id",
    companyId: "productionBales.companyId",
    status: "productionBales.status",
    productId: "productionBales.productId",
    mixBatchId: "productionBales.mixBatchId",
    pressingBatchId: "productionBales.pressingBatchId",
    barcodeValue: "productionBales.barcodeValue",
    baleCode: "productionBales.baleCode",
    createdAt: "productionBales.createdAt",
  },
  insertProductionBaleSchema: { safeParse: vi.fn() },
}));

import { registerProductionBaleRoutes } from "../server/routes/productionBaleRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: any[]) => {
      routes.set(`${method} ${path}`, handlers.at(-1));
    };
  const app: any = {
    get: register("GET"),
    post: register("POST"),
    patch: register("PATCH"),
    put: register("PUT"),
    delete: register("DELETE"),
  };
  registerProductionBaleRoutes(app);
  return routes;
}

function responseHarness() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 4, userId: "admin-1" },
    query: {},
    params: {},
    body: {},
    ...overrides,
  } as any;
}

describe("production bale route behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
  });

  it("lists production bales using company-scoped query filters", async () => {
    harness.storage.getAllProductionBales.mockResolvedValue([{ id: 1, status: "IN_STOCK" }]);
    const res = responseHarness();

    await routes.get("GET /api/production-bales")!(
      request({ query: { mixBatchId: "9", status: "IN_STOCK", category: "A", grade: "B" } }),
      res
    );

    expect(harness.storage.getAllProductionBales).toHaveBeenCalledWith(4, {
      mixBatchId: 9,
      status: "IN_STOCK",
      category: "A",
      grade: "B",
    });
    expect(res.body).toEqual([{ id: 1, status: "IN_STOCK" }]);
  });

  it("rejects production-bale reads when the session has no selected company", async () => {
    const res = responseHarness();
    await routes.get("GET /api/production-bales")!(request({ session: {} }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });

  it("returns barcode lookup results and maps missing bales to 404", async () => {
    harness.storage.getProductionBaleByBarcode
      .mockResolvedValueOnce({ id: 7, barcodeValue: "HD00007" })
      .mockResolvedValueOnce(null);

    const found = responseHarness();
    await routes.get("GET /api/production-bales/barcode/:barcode")!(request({ params: { barcode: "HD00007" } }), found);
    expect(harness.storage.getProductionBaleByBarcode).toHaveBeenCalledWith("HD00007", 4);
    expect(found.body).toMatchObject({ id: 7 });

    const missing = responseHarness();
    await routes.get("GET /api/production-bales/barcode/:barcode")!(
      request({ params: { barcode: "UNKNOWN" } }),
      missing
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ message: "Bale not found" });
  });

  it.each([
    [{ productId: 7, quantity: "2", weightPerBale: "40", mode: "counting" }, "Mix batch is required for counting mode"],
    [
      { mixBatchId: 5, productId: 7, quantity: "2", weightPerBale: "40", mode: "counting" },
      "Location is required for counting mode",
    ],
    [
      { mixBatchId: 5, productId: 7, locationId: 2, quantity: "0", weightPerBale: "40", mode: "counting" },
      "Quantity must be between 1 and 1000",
    ],
    [
      { mixBatchId: 5, productId: 7, locationId: 2, quantity: "2", weightPerBale: "501", mode: "counting" },
      "Weight must be between 1 and 500 kg",
    ],
  ])("validates create-batch input before any mutation: %j", async (body, message) => {
    const res = responseHarness();
    await routes.get("POST /api/production-bales/create-batch")!(request({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message });
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });

  it("refuses products from another company before creating a production batch", async () => {
    harness.selectResults.push([{ id: 7, companyId: 99, code: "HMD01" }]);
    const res = responseHarness();
    await routes.get("POST /api/production-bales/create-batch")!(
      request({
        body: { mixBatchId: 5, productId: 7, locationId: 2, quantity: "2", weightPerBale: "40", mode: "counting" },
      }),
      res
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Product not found" });
  });

  it("costs each bale and draws the mix batch exactly", async () => {
    harness.selectResults.push([{ id: 7, companyId: 4, code: "HMD01" }]);
    harness.storage.getMixBatchById.mockResolvedValue({
      id: 5,
      totalWeightKg: "10",
      usedKg: "0.1",
      costPerKg: "4.35",
    });
    const inserted: Record<string, unknown>[] = [];
    const updates: Record<string, unknown>[] = [];
    const tx: any = {
      select: () => ({ from: () => ({ where: () => ({ for: async () => [{ id: 1, nextNumber: 12 }] }) }) }),
      insert: () => ({
        values: (values: Record<string, unknown>) => {
          inserted.push(values);
          return { returning: async () => [values] };
        },
      }),
      update: () => ({
        set: (values: Record<string, unknown>) => {
          updates.push(values);
          return { where: async () => undefined };
        },
      }),
    };
    harness.db.transaction.mockImplementation(async (callback: (t: unknown) => unknown) => callback(tx));

    const res = responseHarness();
    await routes.get("POST /api/production-bales/create-batch")!(
      request({
        body: { mixBatchId: 5, productId: 7, locationId: 2, quantity: "1", weightPerBale: "0.5", mode: "counting" },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    // 0.5 kg at 4.35 is 2.175, which rounds to 2.18; the float product rounded to 2.17.
    expect(inserted[0]).toMatchObject({ weightKg: "0.5", costPerKg: "4.35", totalCost: "2.18" });
    expect(updates.find((u) => "usedKg" in u)).toMatchObject({ usedKg: "0.600" });
  });

  it("looks up a bale by trimmed barcode and returns the first scoped match", async () => {
    harness.selectResults.push([{ bale: { id: 8 }, product: { id: 7 }, mixBatch: { id: 5 } }]);
    const res = responseHarness();
    await routes.get("GET /api/production-bales/lookup/:barcode")!(
      request({ params: { barcode: "  HD00008  " } }),
      res
    );
    expect(res.body).toEqual({ bale: { id: 8 }, product: { id: 7 }, mixBatch: { id: 5 } });
  });

  it("rejects invalid pressing-batch ids without querying bale details", async () => {
    const res = responseHarness();
    await routes.get("GET /api/pressing-batches/:id")!(request({ params: { id: "bad" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid batch ID" });
  });

  it("aggregates pending and finalized bale counts for each pressing batch", async () => {
    harness.selectResults.push(
      [{ batch: { id: 12 }, product: { id: 7 }, mixBatch: { id: 5 } }],
      [
        { id: 1, status: "PENDING" },
        { id: 2, status: "IN_STOCK" },
        { id: 3, status: "IN_STOCK" },
      ]
    );
    const res = responseHarness();
    await routes.get("GET /api/pressing-batches")!(request(), res);

    expect(res.body).toEqual([
      {
        batch: { id: 12 },
        product: { id: 7 },
        mixBatch: { id: 5 },
        bales: [
          { id: 1, status: "PENDING" },
          { id: 2, status: "IN_STOCK" },
          { id: 3, status: "IN_STOCK" },
        ],
        pendingCount: 1,
        finalizedCount: 2,
      },
    ]);
  });
});
