import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const executeResults: unknown[] = [];
  const selectResults: unknown[][] = [];
  const mutationResults: unknown[][] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      for: vi.fn(() => builder),
      limit: vi.fn(() => Promise.resolve(result)),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const makeMutationBuilder = () => {
    const builder: any = {
      values: vi.fn((values: unknown) => {
        builder.valuesPayload = values;
        return builder;
      }),
      set: vi.fn(() => builder),
      where: vi.fn(() => builder),
      returning: vi.fn(() => Promise.resolve(mutationResults.shift() ?? [])),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  };
  return {
    db: {
      execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
      select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
      insert: vi.fn(() => makeMutationBuilder()),
      update: vi.fn(() => makeMutationBuilder()),
      delete: vi.fn(() => makeMutationBuilder()),
      transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(harness.db)),
    },
    executeResults,
    selectResults,
    mutationResults,
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/queryResult", () => ({ resultRows: (value: any) => value?.rows ?? [] }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  ne: (column: unknown, value: unknown) => ({ type: "ne", column, value }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
  inArray: (column: unknown, values: unknown[]) => ({ type: "inArray", column, values }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  factoryBales: {
    id: "factoryBales.id",
    companyId: "factoryBales.companyId",
    status: "factoryBales.status",
    updatedAt: "factoryBales.updatedAt",
  },
  customerOrders: {
    id: "customerOrders.id",
    companyId: "customerOrders.companyId",
    customerId: "customerOrders.customerId",
    proformaIdUsed: "customerOrders.proformaIdUsed",
    status: "customerOrders.status",
    deletedAt: "customerOrders.deletedAt",
    locationId: "customerOrders.locationId",
    orderDate: "customerOrders.orderDate",
    containerNotes: "customerOrders.containerNotes",
    totalQtyBales: "customerOrders.totalQtyBales",
    loadingStartedAt: "customerOrders.loadingStartedAt",
    loadingFinalizedAt: "customerOrders.loadingFinalizedAt",
    verifiedAt: "customerOrders.verifiedAt",
    updatedAt: "customerOrders.updatedAt",
    grandTotal: "customerOrders.grandTotal",
  },
  customerOrderBales: {
    orderId: "customerOrderBales.orderId",
    articleCode: "customerOrderBales.articleCode",
    baleId: "customerOrderBales.baleId",
    priceUsed: "customerOrderBales.priceUsed",
  },
  customerProformas: {
    id: "customerProformas.id",
    companyId: "customerProformas.companyId",
    customerId: "customerProformas.customerId",
    name: "customerProformas.name",
    deletedAt: "customerProformas.deletedAt",
  },
  customerProformaLines: {
    proformaId: "customerProformaLines.proformaId",
    articleCode: "customerProformaLines.articleCode",
  },
  factoryDaybookEntries: {
    companyId: "factoryDaybookEntries.companyId",
    txType: "factoryDaybookEntries.txType",
    referenceId: "factoryDaybookEntries.referenceId",
  },
  customers: {
    id: "customers.id",
    legalName: "customers.legalName",
    companyId: "customers.companyId",
    deletedAt: "customers.deletedAt",
  },
}));
vi.mock("../server/lib/notificationService", () => ({ dispatchNotification: vi.fn(() => Promise.resolve()) }));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: () => "2026-08-24" }));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: vi.fn(async () => ({ id: 1 })) }));
vi.mock("../server/routes/factory/_stockReservationHelper", () => ({
  syncProformaReservations: vi.fn(async () => undefined),
}));

import { registerCustomerLoadingRoutes } from "../server/routes/factory/products/customerLoadingRoutes";
import { registerOrderLoadingRoutes } from "../server/routes/factory/customer-orders/finalize-loading/loading";

type Handler = (req: any, res: any) => unknown;
function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: any[]) => routes.set(`GET ${path}`, handlers.at(-1)),
    post: (path: string, ...handlers: any[]) => routes.set(`POST ${path}`, handlers.at(-1)),
  };
  registerCustomerLoadingRoutes(app);
  registerOrderLoadingRoutes(app);
  return routes;
}
function req(overrides: Record<string, unknown> = {}) {
  return { session: { factoryCompanyId: 4, currentCompanyId: 99 }, query: { customerId: "12" }, ...overrides } as any;
}
function resHarness() {
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
  };
  return res;
}

describe("customer loading intelligence route", () => {
  const routes = buildRoutes();
  beforeEach(() => {
    vi.clearAllMocks();
    harness.executeResults.splice(0);
    harness.selectResults.splice(0);
    harness.mutationResults.splice(0);
  });

  it("requires a selected company and a positive customer id", async () => {
    const noCompany = resHarness();
    await routes.get("GET /api/factory/customer-loading/products")!(req({ session: {} }), noCompany);
    expect(noCompany.statusCode).toBe(400);
    expect(noCompany.body).toEqual({ message: "No company selected" });

    const invalidCustomer = resHarness();
    await routes.get("GET /api/factory/customer-loading/products")!(
      req({ query: { customerId: "abc" } }),
      invalidCustomer
    );
    expect(invalidCustomer.statusCode).toBe(400);
    expect(invalidCustomer.body).toEqual({ message: "Valid customerId is required" });
  });

  it("does not expose a customer outside the active company", async () => {
    harness.selectResults.push([]);
    const res = resHarness();
    await routes.get("GET /api/factory/customer-loading/products")!(req(), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Customer not found" });
    expect(harness.db.execute).not.toHaveBeenCalled();
  });

  it("classifies active loading orders as loaded and returns customer KPIs", async () => {
    harness.selectResults.push([{ id: 12, legalName: "Customer A" }]);
    harness.executeResults.push({
      rows: [
        {
          id: 1,
          code: "P1",
          articleCode: "HMD11001",
          name: "Shirts",
          nameAr: null,
          categoryId: 3,
          categoryName: "Summer",
          categoryNameAr: null,
          weightPerBaleKg: "40.00",
          sellingPrice: "80.00",
          productionPrice: "50.00",
          active: true,
          totalBalesLoaded: 7,
          totalKgLoaded: "280.000",
          loadingCount: 2,
          lastLoadedAt: "2026-08-17T10:00:00.000Z",
        },
        {
          id: 2,
          code: "P2",
          articleCode: "HMD11002",
          name: "Shorts",
          nameAr: null,
          categoryId: 3,
          categoryName: "Summer",
          categoryNameAr: null,
          weightPerBaleKg: "25.00",
          sellingPrice: "60.00",
          productionPrice: "40.00",
          active: true,
          totalBalesLoaded: 0,
          totalKgLoaded: "0",
          loadingCount: 0,
          lastLoadedAt: null,
        },
      ],
    });
    const res = resHarness();
    await routes.get("GET /api/factory/customer-loading/products")!(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.summary).toEqual({
      totalProducts: 2,
      loadedProducts: 1,
      neverLoadedProducts: 1,
      productCoveragePct: 50,
      totalBalesLoaded: 7,
      totalKgLoaded: 280,
    });
    expect(res.body.products).toEqual([
      expect.objectContaining({ id: 1, loadingStatus: "LOADED", totalBalesLoaded: 7, totalKgLoaded: 280 }),
      expect.objectContaining({ id: 2, loadingStatus: "NEVER_LOADED", totalBalesLoaded: 0, totalKgLoaded: 0 }),
    ]);
    const sqlCall = harness.db.execute.mock.calls[0]?.[0] as any;
    const sqlText = sqlCall.strings.join(" ");
    expect(sqlText).toContain("FROM customer_order_bales cob");
    expect(sqlText).toContain("co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED', 'FINALIZED')");
    expect(sqlText).toContain("co.deleted_at IS NULL");
    expect(sqlText).toContain("DISTINCT ON (cob.bale_id)");
    expect(sqlCall.values).toContain(4);
    expect(sqlCall.values).toContain(12);
  });

  it("validates and scopes history drilldown before reading loading records", async () => {
    const invalid = resHarness();
    await routes.get("GET /api/factory/customer-loading/history")!(
      req({ query: { customerId: "12", productId: "x" } }),
      invalid
    );
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toEqual({ message: "Valid customerId and productId are required" });

    harness.selectResults.push([]);
    const foreignCustomer = resHarness();
    await routes.get("GET /api/factory/customer-loading/history")!(
      req({ query: { customerId: "12", productId: "8" } }),
      foreignCustomer
    );
    expect(foreignCustomer.statusCode).toBe(404);
    expect(harness.db.execute).not.toHaveBeenCalled();
  });

  it("returns deduplicated active-order history with invoice source references", async () => {
    harness.selectResults.push([{ id: 12, legalName: "Customer A" }]);
    harness.executeResults.push(
      { rows: [{ id: 8, code: "P8", articleCode: "HMD8", name: "Asian Wear" }] },
      {
        rows: [
          {
            sessionId: 33,
            invoiceId: 33,
            status: "VERIFIED",
            truckNo: "CONT-4",
            driverName: "Carrier",
            startedAt: "2026-08-17T08:00:00Z",
            completedAt: "2026-08-17T09:00:00Z",
            balesLoaded: 9,
            kgLoaded: "360.000",
            lastScanAt: "2026-08-17T08:55:00Z",
          },
        ],
      }
    );
    const res = resHarness();
    await routes.get("GET /api/factory/customer-loading/history")!(
      req({ query: { customerId: "12", productId: "8" } }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.product).toEqual({ id: 8, code: "P8", articleCode: "HMD8", name: "Asian Wear" });
    expect(res.body.history[0]).toEqual(
      expect.objectContaining({ sessionId: 33, invoiceId: 33, status: "VERIFIED", balesLoaded: 9, kgLoaded: 360 })
    );
    const historySql = harness.db.execute.mock.calls[1]?.[0] as any;
    const historyText = historySql.strings.join(" ");
    expect(historyText).toContain("DISTINCT ON (cob.bale_id)");
    expect(historyText).toContain("co.status IN ('LOADING', 'PENDING_VERIFICATION', 'VERIFIED', 'FINALIZED')");
    expect(historyText).toContain("co.deleted_at IS NULL");
    expect(historyText).toContain("LIMIT 100");
  });

  describe("loading finalization carried-over proforma", () => {
    const finalize = (body: Record<string, unknown> = {}) =>
      routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body, params: { id: "10" } }),
        resHarness()
      ) as Promise<void>;
    const order = {
      id: 10,
      companyId: 4,
      customerId: 12,
      proformaIdUsed: 7,
      locationId: 2,
      orderDate: "2026-08-24",
      status: "LOADING",
      containerNotes: null,
      grandTotal: "0",
    };
    const bale = { orderId: 10, baleId: 20, articleCode: "A", priceUsed: "5" };
    const proforma = { id: 7, companyId: 4, customerId: 12, name: "August Proforma" };
    const line = {
      proformaId: 7,
      articleCode: "A",
      productName: "Product A",
      quantity: 3,
      pricePerBale: "10.00",
      productionPricePerBale: "6.00",
      priceFixed: true,
      pricingMode: "per_kg",
      pricePerKg: "0.250000",
    };
    const setup = (
      overrides: {
        order?: any;
        bales?: any[];
        proforma?: any;
        lines?: any[];
        relatedOrders?: any[];
        relatedBales?: any[];
      } = {}
    ) => {
      harness.selectResults.push(
        [overrides.order ?? order],
        overrides.bales ?? [bale],
        [overrides.proforma ?? proforma],
        overrides.lines ?? [line],
        overrides.relatedOrders ?? [{ id: 10, status: "LOADING" }],
        overrides.relatedBales ?? [bale],
        [{ legalName: "Customer A" }]
      );
      harness.mutationResults.push(
        [{ id: 2, companyId: 4, customerId: 12, name: "August Proforma - 2 Remaining - Carried Over" }],
        [{ ...order, status: "VERIFIED" }]
      );
    };

    it("creates one company-scoped carried-over proforma for a partial loading", async () => {
      setup();
      const response = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        response
      );
      expect(response.statusCode).toBe(200);
      const proformaInsert = harness.db.insert.mock.results[0]?.value;
      expect(proformaInsert.valuesPayload).toEqual({
        companyId: 4,
        customerId: 12,
        name: "August Proforma - 2 Remaining - Carried Over",
        isActive: true,
        status: "ACTIVE",
      });
      const lineInsert = harness.db.insert.mock.results[1]?.value;
      expect(lineInsert.valuesPayload).toEqual([
        {
          proformaId: 2,
          articleCode: "A",
          productName: "Product A",
          quantity: 2,
          pricePerBale: "10.00",
          productionPricePerBale: "6.00",
          priceFixed: true,
          pricingMode: "per_kg",
          pricePerKg: "0.250000",
        },
      ]);
      expect(response.body.carriedOverProforma).toEqual(
        expect.objectContaining({ id: 2, name: "August Proforma - 2 Remaining - Carried Over" })
      );
    });

    it("subtracts loaded bales once across duplicate case-variant article lines", async () => {
      setup({
        lines: [
          { ...line, quantity: 3 },
          { ...line, articleCode: " a ", productName: "Product A second price", quantity: 3, pricePerBale: "12.00" },
        ],
        relatedBales: [
          { ...bale, articleCode: "A" },
          { ...bale, articleCode: "a" },
        ],
      });
      harness.mutationResults[0] = [
        { id: 2, companyId: 4, customerId: 12, name: "August Proforma - 4 Remaining - Carried Over" },
      ];

      const response = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        response
      );

      const lineInsert = harness.db.insert.mock.results[1]?.value;
      expect(lineInsert.valuesPayload).toEqual([
        expect.objectContaining({ articleCode: "A", quantity: 1, pricePerBale: "10.00" }),
        expect.objectContaining({ articleCode: " a ", quantity: 3, pricePerBale: "12.00" }),
      ]);
      expect(response.body.carriedOverProforma.name).toBe("August Proforma - 4 Remaining - Carried Over");
    });

    it("finalizes with NVM without creating a carried-over proforma", async () => {
      setup();
      const response = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: false }, params: { id: "10" } }),
        response
      );
      expect(response.statusCode).toBe(200);
      expect(harness.db.insert).not.toHaveBeenCalled();
      expect(response.body).not.toHaveProperty("carriedOverProforma");
    });

    it("does not split a proforma while another loading still uses it", async () => {
      setup({
        relatedOrders: [
          { id: 10, status: "LOADING" },
          { id: 11, status: "LOADING" },
        ],
      });
      const response = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        response
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).toEqual({
        message: "Cannot move remaining while loading #11 still uses this proforma",
      });
      expect(harness.db.insert).not.toHaveBeenCalled();
      expect(harness.db.update).not.toHaveBeenCalled();
    });

    it("keeps the old behavior for full and no-proforma orders", async () => {
      setup({ relatedBales: [{ articleCode: "A" }, { articleCode: "A" }, { articleCode: "A" }] });
      const fullResponse = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        fullResponse
      );
      expect(harness.db.insert).not.toHaveBeenCalled();
      expect(fullResponse.body).not.toHaveProperty("carriedOverProforma");

      vi.clearAllMocks();
      harness.selectResults.splice(0);
      harness.mutationResults.splice(0);
      setup({ order: { ...order, proformaIdUsed: null } });
      const noProformaResponse = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        noProformaResponse
      );
      expect(harness.db.insert).not.toHaveBeenCalled();
      expect(noProformaResponse.body).not.toHaveProperty("carriedOverProforma");
    });

    it("does not leave a finalized order or carried-over proforma after a transaction error", async () => {
      setup();
      harness.db.transaction.mockRejectedValueOnce(new Error("daybook write failed"));
      const response = resHarness();
      await routes.get("POST /api/factory/customer-orders/:id/finalize-loading")!(
        req({ body: { createCarryoverProforma: true }, params: { id: "10" } }),
        response
      );
      expect(response.statusCode).toBe(400);
      expect(harness.db.update).not.toHaveBeenCalled();
      expect(harness.db.insert).not.toHaveBeenCalled();
      expect(response.body).toEqual({ message: "daybook write failed" });
    });
  });
});
