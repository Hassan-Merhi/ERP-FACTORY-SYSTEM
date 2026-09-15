import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  requireAIActionPermission: vi.fn(),
  logAIAction: vi.fn(),
  clearERPContextCache: vi.fn(),
  listSuppliers: vi.fn(),
  getContainerByNumber: vi.fn(),
  createContainer: vi.fn(),
  createPurchaseOrder: vi.fn(),
  getParentCompanyId: vi.fn(),
  dbSelect: vi.fn(),
  dbInsert: vi.fn(),
  insertValues: vi.fn(),
  loggerError: vi.fn(),
  queryResults: [] as unknown[],
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireNonPOS: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../server/routes/_helpers", () => ({
  upload: {
    single: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
  },
}));

vi.mock("../server/lib/aiActionPermission", () => ({
  requireAIActionPermission: harness.requireAIActionPermission,
  logAIAction: harness.logAIAction,
}));

vi.mock("../server/chatService", () => ({
  extractPOFromText: vi.fn(),
  clearERPContextCache: harness.clearERPContextCache,
}));

vi.mock("../server/excelHelper", () => ({
  readExcel: vi.fn(),
  sheetToJson: vi.fn(),
}));

vi.mock("../server/routes/suppliers/supplierService", () => ({
  supplierService: {
    list: harness.listSuppliers,
  },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getAllStockItems: vi.fn(),
    getStockItemByCodeOrAlias: vi.fn(),
    getContainerByNumber: harness.getContainerByNumber,
    createContainer: harness.createContainer,
    createPurchaseOrder: harness.createPurchaseOrder,
    getParentCompanyId: harness.getParentCompanyId,
  },
}));

vi.mock("../server/db", () => ({
  db: {
    select: harness.dbSelect,
    insert: harness.dbInsert,
  },
}));

vi.mock("../server/lib/logger", () => ({
  logger: {
    error: harness.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { registerChatbotPoImportRoutes } from "../server/routes/chatbotPoImportRoutes";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

function queryFor(value: unknown) {
  const query: any = {};
  query.from = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  query.innerJoin = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  return query;
}

function queueQueries(...results: unknown[]) {
  harness.queryResults.splice(0, harness.queryResults.length, ...results);
}

function captureConfirmHandler() {
  const routes = new Map<string, Handler>();
  const app = {
    post: vi.fn((path: string, ...handlers: Handler[]) => {
      routes.set(path, handlers.at(-1)!);
    }),
  };
  registerChatbotPoImportRoutes(app as any);
  return routes.get("/api/chatbot/confirm-po-import")!;
}

function responseHarness() {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

function confirmRequest(bodyOverrides: Record<string, unknown> = {}, requestOverrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 7 },
    body: {
      poNumber: "PO-30-CONFIRM",
      containerNumber: "MSKU1234567",
      importDate: "2026-09-15",
      currency: "USD",
      supplierId: 10,
      lines: [{ stockItemId: 20, itemName: "Widget", rawName: "Widget", qty: "2", rate: "3.50" }],
      charges: {},
      ...bodyOverrides,
    },
    query: {},
    ...requestOverrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.queryResults.length = 0;
  harness.requireAIActionPermission.mockResolvedValue(null);
  harness.logAIAction.mockResolvedValue(undefined);
  harness.listSuppliers.mockResolvedValue([{ id: 10, legalName: "Alpha Supplier" }]);
  harness.getContainerByNumber.mockResolvedValue(null);
  harness.createContainer.mockResolvedValue({ id: 100, containerNumber: "MSKU1234567" });
  harness.createPurchaseOrder.mockResolvedValue({ id: 200, poNumber: "PO-30-CONFIRM" });
  harness.getParentCompanyId.mockResolvedValue(null);
  harness.clearERPContextCache.mockReturnValue(undefined);
  harness.dbSelect.mockImplementation(() => queryFor(harness.queryResults.shift() ?? []));
  harness.insertValues.mockResolvedValue(undefined);
  harness.dbInsert.mockReturnValue({ values: harness.insertValues });
});

describe("Phase 30 chatbot PO confirm branch gaps", () => {
  it("rejects confirmation without a selected company", async () => {
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest({}, { session: {} }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
    expect(harness.requireAIActionPermission).not.toHaveBeenCalled();
  });

  it("honors AI write permission denial before validating or writing", async () => {
    harness.requireAIActionPermission.mockResolvedValue({ code: 403, message: "AI write denied" });
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "AI write denied" });
    expect(harness.listSuppliers).not.toHaveBeenCalled();
  });

  it.each([
    ["PO number", { poNumber: "" }, "PO number is required"],
    ["container number", { containerNumber: "" }, "Container number is required"],
    ["supplier", { supplierId: null }, "Supplier is required"],
    ["line items", { lines: [] }, "At least one line item is required"],
  ])("rejects a missing %s", async (_label, overrides, message) => {
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(overrides), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message });
    expect(harness.listSuppliers).not.toHaveBeenCalled();
  });

  it("rejects suppliers outside the visible company supplier set", async () => {
    harness.listSuppliers.mockResolvedValue([{ id: 11, legalName: "Other Supplier" }]);
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Supplier not found" });
    expect(harness.dbSelect).not.toHaveBeenCalled();
  });

  it("rejects unresolved line items with their best available names", async () => {
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(
      confirmRequest({
        lines: [
          { stockItemId: null, rawName: "Raw Bale", qty: "1", rate: "2" },
          { stockItemId: undefined, itemName: "Named Bale", qty: "1", rate: "3" },
        ],
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "2 item(s) still unresolved: Raw Bale, Named Bale" });
    expect(harness.dbSelect).not.toHaveBeenCalled();
  });

  it("blocks a duplicate PO number before looking up or creating a container", async () => {
    queueQueries([{ id: 900 }]);
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(), res);

    expect(res.statusCode).toBe(409);
    expect(String(res.body.message)).toContain("already exists");
    expect(harness.getContainerByNumber).not.toHaveBeenCalled();
  });

  it("blocks an existing container that already has imported purchase orders", async () => {
    queueQueries(
      [],
      [
        { id: 1, poNumber: "PO-OLD-1" },
        { id: 2, poNumber: "PO-OLD-2" },
      ]
    );
    harness.getContainerByNumber.mockResolvedValue({ id: 321, containerNumber: "MSKU1234567" });
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(), res);

    expect(res.statusCode).toBe(409);
    expect(String(res.body.message)).toContain("already has 2 PO(s) imported");
    expect(String(res.body.message)).toContain("PO-OLD-1, PO-OLD-2");
    expect(harness.createPurchaseOrder).not.toHaveBeenCalled();
  });

  it("creates a new container and persists charged line items with complete audit evidence", async () => {
    queueQueries([], [{ id: 501, reference: "PRO-501" }]);
    harness.getParentCompanyId.mockResolvedValue(1);
    harness.createContainer.mockResolvedValue({ id: 100, containerNumber: "MSKU1234567" });
    harness.createPurchaseOrder.mockResolvedValue({ id: 200, poNumber: "PO-30-CONFIRM" });
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(
      confirmRequest({
        currency: "EUR",
        lines: [
          { stockItemId: 20, itemName: "Widget", rawName: "Raw Widget", qty: "2", rate: "3.50" },
          { stockItemId: 21, rawName: "Raw Bale", qty: "1.5", rate: "4" },
          { stockItemId: 22, qty: "1", rate: "2" },
        ],
        charges: {
          freight: "10",
          surcharge: "2",
          fumigation: "3",
          documentCharges: "4",
          discount: "5",
          otherCharges: "6",
        },
      }),
      res
    );

    expect(harness.createContainer).toHaveBeenCalledWith({
      companyId: 7,
      containerNumber: "MSKU1234567",
      supplierId: 10,
      status: "OTW",
      importDate: "2026-09-15",
    });
    expect(harness.createPurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 7,
        poNumber: "PO-30-CONFIRM",
        containerId: 100,
        supplierId: 10,
        currency: "EUR",
        itemsTotal: "15.00",
        freight: "10.00",
        surcharge: "2.00",
        fumigation: "3.00",
        documentCharges: "4.00",
        discount: "5.00",
        otherCharges: "6.00",
        chargesEdited: true,
      }),
      "2026-09-15"
    );
    expect(harness.insertValues).toHaveBeenCalledTimes(3);
    expect(harness.insertValues).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stockItemId: 20,
        itemName: "Widget",
        quantity: "2.000",
        rate: "3.50",
        lineTotal: "7.00",
      })
    );
    expect(harness.insertValues).toHaveBeenNthCalledWith(2, expect.objectContaining({ itemName: "Raw Bale" }));
    expect(harness.insertValues).toHaveBeenNthCalledWith(3, expect.objectContaining({ itemName: "Unknown Item" }));
    expect(harness.logAIAction).toHaveBeenCalledWith(
      expect.objectContaining({
        actionType: "write",
        actionName: "po_import",
        status: "success",
        createdRecordId: 200,
      })
    );
    expect(harness.clearERPContextCache).toHaveBeenCalledWith(7);
    expect(res.body).toEqual({
      success: true,
      poId: 200,
      poNumber: "PO-30-CONFIRM",
      containerNumber: "MSKU1234567",
      containerId: 100,
      supplierId: 10,
      lineCount: 3,
      itemsTotal: "15.00",
      grandTotal: "35.00",
      crossCompany: true,
      availableProformas: [{ id: 501, reference: "PRO-501" }],
    });
  });

  it("reuses an empty existing container and defaults missing currency and charges without marking charges edited", async () => {
    queueQueries([], [], []);
    harness.getContainerByNumber.mockResolvedValue({ id: 444, containerNumber: "MSKU1234567" });
    harness.createPurchaseOrder.mockResolvedValue({ id: 445, poNumber: "PO-30-CONFIRM" });
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest({ currency: "", charges: undefined }), res);

    expect(harness.createContainer).not.toHaveBeenCalled();
    expect(harness.createPurchaseOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        containerId: 444,
        currency: "USD",
        freight: "0.00",
        surcharge: "0.00",
        fumigation: "0.00",
        documentCharges: "0.00",
        discount: "0.00",
        otherCharges: "0.00",
        chargesEdited: false,
      }),
      "2026-09-15"
    );
    expect(res.body.crossCompany).toBe(false);
    expect(res.body.grandTotal).toBe("7.00");
  });

  it("converts an unexpected confirmation failure into a controlled 500", async () => {
    harness.listSuppliers.mockRejectedValue(new Error("supplier visibility query failed"));
    const handler = captureConfirmHandler();
    const res = responseHarness();

    await handler(confirmRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
    expect(harness.loggerError).toHaveBeenCalled();
  });
});
