import ExcelJS from "exceljs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  return {
    selectResults,
    db: {
      select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
    },
    writeAuditEvent: vi.fn(async () => undefined),
    getExportPriceVisibility: vi.fn(async () => ({ hideSelling: false })),
    loggerError: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/helpers/exportVisibility", () => ({
  getExportPriceVisibility: harness.getExportPriceVisibility,
}));
vi.mock("../server/services/audit/auditService", () => ({ writeAuditEvent: harness.writeAuditEvent }));
vi.mock("../server/lib/logger", () => ({ logger: { error: harness.loggerError } }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));

import { buildOrderExcelBuffer } from "../server/routes/factory/customer-orders/orderHelpers";
import { registerFactoryBilingualDocumentRoutes } from "../server/routes/factory/factoryBilingualDocumentRoutes";

type Handler = (req: any, res: any, next?: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: Handler[]) => routes.set(`GET ${path}`, handlers.at(-1)!),
  };
  registerFactoryBilingualDocumentRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    method: "GET",
    path: "/api/factory/customer-orders/12/export/excel",
    session: { factoryCompanyId: 7, currentCompanyId: 8, userId: 44 },
    params: { id: "12" },
    query: { lang: "en" },
    ...overrides,
  } as any;
}

function resHarness() {
  const headers = new Map<string, unknown>();
  const res: any = {
    statusCode: 200,
    body: undefined,
    ended: undefined,
    headersSent: false,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    setHeader: vi.fn((name: string, value: unknown) => {
      headers.set(name, value);
      return res;
    }),
    end: vi.fn((body: unknown) => {
      res.ended = body;
      res.headersSent = true;
      return res;
    }),
    headers,
  };
  return res;
}

const order = {
  id: 12,
  invoiceNumber: "INV-0012",
  orderDate: "2026-09-17",
  status: "VERIFIED",
  subtotalBales: "100",
  freightAmount: "10",
  otherChargesTotal: "5",
  grandTotal: "115",
  totalQtyBales: 2,
  containerNumber: "MSCU1234567",
  destination: "Lusaka",
  customerName: "Acme Trading",
  customerCode: "ACME",
  baseCurrency: "USD",
};

const line = {
  articleCode: "HMD10001",
  baleName: "Shirts",
  qty: "2",
  weightPerBale: "40",
  totalWeight: "80",
  pricingMode: "per_bale",
  pricePerBale: "50",
  pricePerKg: "0",
  totalPrice: "100",
};

describe("Phase 33D bilingual factory document routes", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.getExportPriceVisibility.mockResolvedValue({ hideSelling: false });
  });

  it("preserves the legacy route when no explicit supported language is requested", async () => {
    const next = vi.fn();
    const res = resHarness();

    await routes.get("GET /api/factory/customer-orders/:id/export/excel")!(req({ query: {} }), res, next);

    expect(next).toHaveBeenCalledOnce();
    expect(harness.db.select).not.toHaveBeenCalled();
    expect(res.end).not.toHaveBeenCalled();
  });

  it("enforces factory company access and positive order identifiers before loading data", async () => {
    const noCompany = resHarness();
    await routes.get("GET /api/factory/customer-orders/:id/export/excel")!(
      req({ session: {}, query: { lang: "ar" } }),
      noCompany,
      vi.fn()
    );
    expect(noCompany.statusCode).toBe(403);
    expect(noCompany.body).toEqual({ message: "Factory company access required" });

    const badId = resHarness();
    await routes.get("GET /api/factory/customer-orders/:id/export/excel")!(
      req({ params: { id: "0" } }),
      badId,
      vi.fn()
    );
    expect(badId.statusCode).toBe(400);
    expect(badId.body).toEqual({ message: "Invalid order ID" });
  });

  it("returns not found when the order does not belong to the selected factory company", async () => {
    harness.selectResults.push([]);
    const res = resHarness();

    await routes.get("GET /api/factory/customer-orders/:id/export/excel")!(req(), res, vi.fn());

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Order not found" });
    expect(harness.writeAuditEvent).not.toHaveBeenCalled();
  });

  it("builds an English Excel invoice, sets attachment headers, and audits the export", async () => {
    harness.selectResults.push([order], [line], [{ name: "Handling", amount: "5" }]);
    const res = resHarness();

    await routes.get("GET /api/factory/customer-orders/:id/export/excel")!(req(), res, vi.fn());

    expect(res.statusCode).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(String(res.headers.get("Content-Disposition"))).toContain("attachment");
    expect(Buffer.isBuffer(res.ended)).toBe(true);
    expect((res.ended as Buffer).byteLength).toBeGreaterThan(100);
    expect(harness.getExportPriceVisibility).toHaveBeenCalledOnce();
    expect(harness.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "factory_bilingual_document_export",
        entityType: "customer_order",
        entityId: 12,
        companyId: 7,
        userId: 44,
        metadata: expect.objectContaining({ format: "excel", language: "en", noCharges: false }),
      })
    );
  });

  it("builds the bilingual loading workbook and audits the loading export path", async () => {
    harness.selectResults.push(
      [order],
      [line],
      [],
      [
        { baleReference: "B-1", articleCode: "HMD10001", baleName: "Shirts", weight: "40" },
        { baleReference: "B-2", articleCode: "HMD10001", baleName: "Shirts", weight: "42" },
      ]
    );
    const res = resHarness();

    await routes.get("GET /api/factory/customer-orders/:id/loading-list")!(
      req({ path: "/api/factory/customer-orders/12/loading-list", query: { lang: "ar" } }),
      res,
      vi.fn()
    );

    expect(Buffer.isBuffer(res.ended)).toBe(true);
    expect(harness.writeAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        entityId: 12,
        companyId: 7,
        metadata: expect.objectContaining({ format: "loading-xlsx", language: "ar" }),
      })
    );
  });
});

describe("Phase 33D customer-order Excel helper", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
  });

  it("fails closed when an order cannot be found inside the requested company", async () => {
    harness.selectResults.push([{ baseCurrency: "USD" }], []);

    await expect(buildOrderExcelBuffer(99, 7, false)).rejects.toThrow("Order 99 not found for company 7");
  });

  it("uses catalog names/weights, per-kg pricing, explicit charges, and the company currency", async () => {
    harness.selectResults.push(
      [{ baseCurrency: "EUR" }],
      [{ ...order, customerName: "Acme Trading" }],
      [{ name: "Handling", amount: "7.50", chargeType: "OTHER" }],
      [
        {
          ...line,
          pricingMode: "per_kg",
          pricePerKg: "2",
          totalWeight: "80",
          totalPrice: "160",
        },
      ],
      [{ articleCode: "HMD10001", name: "Catalog Shirts", weightPerBaleKg: "41.5" }]
    );

    const result = await buildOrderExcelBuffer(12, 7, false);
    expect(Buffer.isBuffer(result.buffer)).toBe(true);
    expect(result.fileName).toMatch(/\.xlsx$/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as any);
    const sheet = workbook.worksheets[0];
    const text = sheet
      .getSheetValues()
      .flatMap((row: any) => (Array.isArray(row) ? row : []))
      .filter((value: unknown) => value !== undefined && value !== null)
      .map(String);

    expect(text).toContain("Price/KG");
    expect(text).toContain("Catalog Shirts");
    expect(text).toContain("41.50");
    expect(text).toContain("Handling");
    expect(text.some((value) => value.includes("€"))).toBe(true);
  });

  it("omits selling-price and charge-summary columns when hideSelling is enabled", async () => {
    harness.selectResults.push(
      [{ baseCurrency: "USD" }],
      [order],
      [{ name: "Handling", amount: "5", chargeType: "OTHER" }],
      [line],
      [{ articleCode: "HMD10001", name: "Catalog Shirts", weightPerBaleKg: "40" }]
    );

    const result = await buildOrderExcelBuffer(12, 7, true);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(result.buffer as any);
    const sheet = workbook.worksheets[0];
    const text = sheet
      .getSheetValues()
      .flatMap((row: any) => (Array.isArray(row) ? row : []))
      .filter((value: unknown) => value !== undefined && value !== null)
      .map(String);

    expect(text).not.toContain("Price/Bale");
    expect(text).not.toContain("Price/KG");
    expect(text).not.toContain("Grand Total");
    expect(text).not.toContain("Handling");
  });
});