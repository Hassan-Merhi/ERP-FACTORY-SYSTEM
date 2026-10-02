import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  logAudit: vi.fn(async () => undefined),
  getExportPriceVisibility: vi.fn(async () => ({ hideSelling: false })),
  getCanonicalInvoiceDocument: vi.fn(),
  buildCanonicalInvoiceExcel: vi.fn(),
}));

vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/routes/helpers/auditHelpers", () => ({ logAudit: harness.logAudit }));
vi.mock("../server/helpers/exportVisibility", () => ({
  getExportPriceVisibility: harness.getExportPriceVisibility,
}));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: any) => error?.message || String(error),
  getErrorStack: () => "stack",
}));
vi.mock("../server/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../server/lib/contentDisposition", () => ({
  contentDisposition: (name: string) => `attachment; filename=${name}`,
}));
vi.mock("../server/lib/parseId", () => ({
  parseId: (value: unknown) => {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  },
}));
vi.mock("../server/services/factoryInvoiceDocumentService", () => ({
  getCanonicalInvoiceDocument: harness.getCanonicalInvoiceDocument,
  buildCanonicalInvoiceExcel: harness.buildCanonicalInvoiceExcel,
}));

import { registerOrderExcelExportRoutes } from "../server/routes/factory/customer-orders/orderExcelExportRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: any[]) => routes.set(path, handlers.at(-1)),
  };
  registerOrderExcelExportRoutes(app);
  return routes;
}

function responseHarness() {
  const headers = new Map<string, unknown>();
  const res: any = {
    statusCode: 200,
    body: undefined,
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
    setHeader: vi.fn((name: string, value: unknown) => headers.set(name, value)),
    end: vi.fn((body?: unknown) => {
      res.body = body;
      res.headersSent = true;
      return res;
    }),
    headers,
  };
  return res;
}

const document = {
  version: 1,
  orderId: 20,
  companyId: 4,
  invoiceNumber: "INV-20",
  orderDate: "2026-08-12",
  status: "FINALIZED",
  customerName: "Customer A",
  customerCode: "CUS-A",
  baseCurrency: "USD",
  containerNumber: "CONT-1",
  destination: "Kolwezi",
  shippingCompany: "",
  subtotalBales: 75,
  freightAmount: 10,
  otherChargesTotal: 5,
  grandTotal: 90,
  totalQtyBales: 3,
  lines: [],
  charges: [],
  frozenAt: "2026-08-12T00:00:00.000Z",
};

describe("customer order Excel export behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.getExportPriceVisibility.mockResolvedValue({ hideSelling: false });
    harness.getCanonicalInvoiceDocument.mockResolvedValue(document);
    harness.buildCanonicalInvoiceExcel.mockResolvedValue({
      buffer: Buffer.from("PKcanonical-invoice"),
      fileName: "CONT-1_Customer-A_Kolwezi_INV-20.xlsx",
    });
  });

  it("routes both legacy Excel URLs through the same canonical document renderer", async () => {
    for (const path of [
      "/api/factory/customer-orders/:id/export/excel",
      "/api/factory/customer-orders/:id/export-excel",
    ]) {
      const res = responseHarness();
      await routes.get(path)!(
        {
          session: { currentCompanyId: 4, userId: "admin-1", username: "admin" },
          params: { id: "20" },
          query: {},
        },
        res
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers.get("Content-Type")).toBe(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      expect(res.body).toEqual(Buffer.from("PKcanonical-invoice"));
    }

    expect(harness.getCanonicalInvoiceDocument).toHaveBeenCalledTimes(2);
    expect(harness.getCanonicalInvoiceDocument).toHaveBeenNthCalledWith(1, 20, 4);
    expect(harness.getCanonicalInvoiceDocument).toHaveBeenNthCalledWith(2, 20, 4);
    expect(harness.buildCanonicalInvoiceExcel).toHaveBeenCalledTimes(2);
  });

  it("honors hidden selling columns and the no-charges download option", async () => {
    harness.getExportPriceVisibility.mockResolvedValue({ hideSelling: true });
    const res = responseHarness();

    await routes.get("/api/factory/customer-orders/:id/export-excel")!(
      {
        session: { factoryCompanyId: 4, userId: "admin-1" },
        params: { id: "20" },
        query: { noCharges: "1" },
      },
      res
    );

    expect(harness.buildCanonicalInvoiceExcel).toHaveBeenCalledWith(
      document,
      expect.objectContaining({ hideSelling: true, noCharges: true, language: "en" })
    );
    expect(res.statusCode).toBe(200);
  });

  it("rejects missing company, invalid ids and missing canonical orders", async () => {
    const noCompany = responseHarness();
    await routes.get("/api/factory/customer-orders/:id/export-excel")!(
      { session: {}, params: { id: "20" }, query: {} },
      noCompany
    );
    expect(noCompany.statusCode).toBe(400);

    const invalid = responseHarness();
    await routes.get("/api/factory/customer-orders/:id/export-excel")!(
      { session: { currentCompanyId: 4 }, params: { id: "bad" }, query: {} },
      invalid
    );
    expect(invalid.statusCode).toBe(400);

    harness.getCanonicalInvoiceDocument.mockResolvedValueOnce(null);
    const missing = responseHarness();
    await routes.get("/api/factory/customer-orders/:id/export-excel")!(
      { session: { currentCompanyId: 4 }, params: { id: "99" }, query: {} },
      missing
    );
    expect(missing.statusCode).toBe(404);
  });
});
