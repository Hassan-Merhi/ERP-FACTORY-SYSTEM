import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  requireAIActionPermission: vi.fn(),
  logAIAction: vi.fn(),
  extractPOFromText: vi.fn(),
  clearERPContextCache: vi.fn(),
  readExcel: vi.fn(),
  sheetToJson: vi.fn(),
  listSuppliers: vi.fn(),
  getAllStockItems: vi.fn(),
  getStockItemByCodeOrAlias: vi.fn(),
  loggerError: vi.fn(),
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
  extractPOFromText: harness.extractPOFromText,
  clearERPContextCache: harness.clearERPContextCache,
}));

vi.mock("../server/excelHelper", () => ({
  readExcel: harness.readExcel,
  sheetToJson: harness.sheetToJson,
}));

vi.mock("../server/routes/suppliers/supplierService", () => ({
  supplierService: {
    list: harness.listSuppliers,
  },
}));

vi.mock("../server/storage", () => ({
  storage: {
    getAllStockItems: harness.getAllStockItems,
    getStockItemByCodeOrAlias: harness.getStockItemByCodeOrAlias,
  },
}));

vi.mock("../server/db", () => ({
  db: {},
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

const suppliers = [
  { id: 10, code: "SUP-A", legalName: "Alpha Supplier" },
  { id: 11, code: null, legalName: "Beta Trading" },
];
const stockItems = [
  { id: 20, code: "WID", name: "Widget" },
  { id: 21, code: null, name: "Loose Bale" },
];

function captureRoutes() {
  const routes = new Map<string, Handler>();
  const app = {
    post: vi.fn((path: string, ...handlers: Handler[]) => {
      routes.set(path, handlers.at(-1)!);
    }),
  };
  registerChatbotPoImportRoutes(app as any);
  return routes;
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

function parseRequest(overrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 7 },
    file: {
      originalname: "po.csv",
      buffer: Buffer.from("Item,Quantity,Rate\nWidget,1,2"),
    },
    body: {},
    query: {},
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.requireAIActionPermission.mockResolvedValue(null);
  harness.listSuppliers.mockResolvedValue(suppliers);
  harness.getAllStockItems.mockResolvedValue(stockItems);
  harness.getStockItemByCodeOrAlias.mockResolvedValue(null);
  harness.readExcel.mockResolvedValue({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
  harness.sheetToJson.mockReturnValue([]);
  harness.extractPOFromText.mockResolvedValue(null);
  harness.logAIAction.mockResolvedValue(undefined);
  harness.clearERPContextCache.mockReturnValue(undefined);
});

describe("Phase 30 chatbot PO import branch gaps", () => {
  it("rejects parse requests without a selected company", async () => {
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ session: {} }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
    expect(harness.listSuppliers).not.toHaveBeenCalled();
  });

  it("rejects parse requests without an uploaded file", async () => {
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: undefined }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No file uploaded" });
  });

  it("honors AI draft permission denial before reading supplier or stock data", async () => {
    harness.requireAIActionPermission.mockResolvedValue({ code: 403, message: "AI draft denied" });
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest(), res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "AI draft denied" });
    expect(harness.listSuppliers).not.toHaveBeenCalled();
  });

  it("maps a CSV directly, matching supplier and item by code and calculating charges", async () => {
    harness.getStockItemByCodeOrAlias.mockResolvedValueOnce({ id: 20, name: "Widget" });
    const csv = [
      "PO Number,Container Number,Supplier Code,Currency,Item Code,Item Name,Quantity,Rate,Freight,Surcharge,Fumigation,Document Charges,Discount,Other Charges",
      "PO-30,MSKU1234567,SUP-A,USD,WID,Widget,2,3.5,10,2,1,4,3,5",
      "PO-30,MSKU1234567,SUP-A,USD,,,0,9,10,2,1,4,3,5",
    ].join("\n");
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.CSV", buffer: Buffer.from(csv) } }), res);

    expect(res.status).not.toHaveBeenCalled();
    expect(res.body).toMatchObject({
      poNumber: "PO-30",
      containerNumber: "MSKU1234567",
      currency: "USD",
      supplierId: 10,
      supplierName: "Alpha Supplier",
      itemsTotal: "7.00",
      grandTotal: "26.00",
      unresolvedSupplier: false,
      unresolvedItems: [],
    });
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0]).toMatchObject({ stockItemId: 20, qty: "2", rate: "3.50", lineTotal: "7.00" });
  });

  it("matches supplier by partial name and stock item by in-memory name after code lookup misses", async () => {
    harness.getStockItemByCodeOrAlias.mockResolvedValue(null);
    const csv = [
      "Supplier,Barcode,Description,Qty,Unit Price",
      "Beta,UNKNOWN,Widget,3,4",
    ].join("\n");
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.csv", buffer: Buffer.from(csv) } }), res);

    expect(res.body).toMatchObject({ supplierId: 11, supplierName: "Beta Trading", itemsTotal: "12.00", grandTotal: "12.00" });
    expect(res.body.lines[0]).toMatchObject({ stockItemId: 20, stockItemName: "Widget" });
  });

  it("keeps unresolved supplier/items explicit instead of guessing", async () => {
    const csv = ["Vendor,SKU,Product,Units,Unit Cost", "Mystery Co,NOPE,Unknown Bale,5,2"].join("\n");
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.csv", buffer: Buffer.from(csv) } }), res);

    expect(res.body).toMatchObject({
      supplierId: null,
      supplierName: "Mystery Co",
      supplierRaw: "Mystery Co",
      unresolvedSupplier: true,
    });
    expect(res.body.unresolvedItems).toEqual([{ index: 0, rawName: "Unknown Bale", rawCode: "NOPE" }]);
  });

  it("rejects a CSV with headers but no data rows", async () => {
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "empty.csv", buffer: Buffer.from("Item,Quantity,Rate\n") } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "CSV file has no data rows" });
  });

  it("ignores blank CSV rows and falls back to AI when standard columns do not yield an item", async () => {
    harness.extractPOFromText.mockResolvedValue({
      poNumber: "AI-30",
      containerNumber: "",
      supplierName: "Alpha",
      supplierCode: "",
      importDate: "",
      currency: "",
      items: [
        { name: "Widget", code: "", quantity: 2, rate: 6 },
        { name: "Skip Me", code: "", quantity: 0, rate: 99 },
        { name: "Unresolved", code: "BAD", quantity: 1, rate: 0 },
      ],
      freight: 1,
      surcharge: 2,
      fumigation: 3,
      documentCharges: 4,
      discount: 5,
      otherCharges: 6,
    });
    const csv = ["Odd Header,Something", "abc,def", ","].join("\n");
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "odd.csv", buffer: Buffer.from(csv) } }), res);

    expect(harness.extractPOFromText).toHaveBeenCalledWith(expect.stringContaining("Odd Header: abc"));
    expect(res.body).toMatchObject({
      poNumber: "AI-30",
      currency: "USD",
      supplierId: 10,
      supplierName: "Alpha Supplier",
      itemsTotal: "12.00",
      grandTotal: "23.00",
      unresolvedSupplier: false,
    });
    expect(res.body.lines).toHaveLength(2);
    expect(res.body.unresolvedItems).toEqual([{ index: 1, rawName: "Unresolved", rawCode: "BAD" }]);
  });

  it("rejects AI fallback data when no purchase-order items can be extracted", async () => {
    harness.extractPOFromText.mockResolvedValue({ items: [] });
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(
      parseRequest({ file: { originalname: "odd.csv", buffer: Buffer.from("Odd Header,Something\nabc,def") } }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ rowCount: 1 });
    expect(String(res.body.message)).toContain("Could not find item rows");
  });

  it("returns a controlled error when Excel parsing throws", async () => {
    harness.readExcel.mockRejectedValue(new Error("broken workbook"));
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.xlsx", buffer: Buffer.from("broken") } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Could not read file: broken workbook" });
  });

  it("rejects an Excel workbook without a sheet", async () => {
    harness.readExcel.mockResolvedValue({ SheetNames: [], Sheets: {} });
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.xlsx", buffer: Buffer.from("xlsx") } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Excel file is empty" });
  });

  it("rejects an Excel sheet that has no rows", async () => {
    harness.sheetToJson.mockReturnValue([]);
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.xlsx", buffer: Buffer.from("xlsx") } }), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "File has no data rows" });
  });

  it("maps flexible Excel columns and handles invalid numeric charges as zero", async () => {
    harness.sheetToJson.mockReturnValue([
      {
        "PO No": "XLS-30",
        Vendor: "Alpha Supplier",
        Product: "Loose Bale",
        Units: "2",
        "Unit Cost": "7.25",
        Freight: "not-a-number",
        Discount: "bad",
      },
    ]);
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest({ file: { originalname: "po.xlsx", buffer: Buffer.from("xlsx") } }), res);

    expect(res.body).toMatchObject({
      poNumber: "XLS-30",
      supplierId: 10,
      itemsTotal: "14.50",
      grandTotal: "14.50",
    });
    expect(res.body.lines[0]).toMatchObject({ stockItemId: 21, rawName: "Loose Bale" });
  });

  it("converts an unexpected parser failure into a controlled 500 response", async () => {
    harness.listSuppliers.mockRejectedValue(new Error("supplier lookup exploded"));
    const handler = captureRoutes().get("/api/chatbot/parse-po-file")!;
    const res = responseHarness();

    await handler(parseRequest(), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Internal server error" });
    expect(harness.loggerError).toHaveBeenCalled();
  });
});
