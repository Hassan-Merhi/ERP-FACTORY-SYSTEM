import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  storage: {
    getAllPendingBarcodes: vi.fn(),
    getPendingBarcodeByCode: vi.fn(),
    createPendingBarcode: vi.fn(),
    bulkCreatePendingBarcodes: vi.fn(),
    updatePendingBarcode: vi.fn(),
    markBarcodesAsPrinted: vi.fn(),
    deletePendingBarcode: vi.fn(),
    getAllBaleProductCategories: vi.fn(),
    getBaleProductCategoryByName: vi.fn(),
    createBaleProductCategory: vi.fn(),
    getBaleProductCategoryById: vi.fn(),
    updateBaleProductCategory: vi.fn(),
    deleteBaleProductCategory: vi.fn(),
    getAllBaleProducts: vi.fn(),
    getBaleProductById: vi.fn(),
    getBaleProductByArticleCode: vi.fn(),
    createBaleProduct: vi.fn(),
    updateBaleProduct: vi.fn(),
    deleteBaleProduct: vi.fn(),
  },
  pendingParse: vi.fn((value: any) => value),
  categoryParse: vi.fn((value: any) => value),
  productParse: vi.fn((value: any) => value),
  productPartialParse: vi.fn((value: any) => value),
}));

vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/db", () => ({ db: { transaction: vi.fn() } }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/routes/_helpers", () => {
  const passThrough = { single: () => (_req: any, _res: any, next: any) => next() };
  return { upload: passThrough, spreadsheetUpload: passThrough, generalUpload: passThrough };
});
vi.mock("../server/excelHelper", () => ({ readExcel: vi.fn(), sheetToJson: vi.fn() }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ column, value }),
  and: (...conditions: unknown[]) => ({ conditions }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  baleProducts: { id: "baleProducts.id", companyId: "baleProducts.companyId", articleCode: "baleProducts.articleCode" },
  baleProductCategories: { id: "categories.id", companyId: "categories.companyId" },
  insertPendingBarcodeSchema: { parse: harness.pendingParse },
  insertBaleProductCategorySchema: { parse: harness.categoryParse },
  insertBaleProductSchema: {
    parse: harness.productParse,
    partial: () => ({ parse: harness.productPartialParse }),
  },
}));

import { registerBaleProductRoutes } from "../server/routes/baleProductRoutes";

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
  registerBaleProductRoutes(app);
  return routes;
}

function request(overrides: Record<string, unknown> = {}) {
  return { session: { currentCompanyId: 4 }, params: {}, body: {}, query: {}, ...overrides } as any;
}

function responseHarness() {
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
    send: vi.fn((body?: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe("bale product catalog route behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.pendingParse.mockImplementation((value: any) => value);
    harness.categoryParse.mockImplementation((value: any) => value);
    harness.productParse.mockImplementation((value: any) => value);
    harness.productPartialParse.mockImplementation((value: any) => value);
  });

  it("lists and looks up pending barcodes inside the active company", async () => {
    harness.storage.getAllPendingBarcodes.mockResolvedValue([{ id: 1, barcode: "HD001" }]);
    harness.storage.getPendingBarcodeByCode.mockResolvedValue({ id: 1, barcode: "HD001" });

    const list = responseHarness();
    await routes.get("GET /api/pending-barcodes")!(request(), list);
    expect(harness.storage.getAllPendingBarcodes).toHaveBeenCalledWith(4);
    expect(list.body).toEqual([{ id: 1, barcode: "HD001" }]);

    const found = responseHarness();
    await routes.get("GET /api/pending-barcodes/:barcode")!(request({ params: { barcode: "HD001" } }), found);
    expect(harness.storage.getPendingBarcodeByCode).toHaveBeenCalledWith("HD001", 4);
    expect(found.body).toMatchObject({ barcode: "HD001" });
  });

  it("creates pending barcodes with the session company and imports mixed barcode shapes", async () => {
    harness.storage.createPendingBarcode.mockImplementation(async (value) => ({ id: 2, ...value }));
    harness.storage.bulkCreatePendingBarcodes.mockImplementation(async (values) =>
      values.map((value: any, i: number) => ({ id: i + 1, ...value }))
    );

    const created = responseHarness();
    await routes.get("POST /api/pending-barcodes")!(request({ body: { barcode: "HD002", category: "A" } }), created);
    expect(harness.pendingParse).toHaveBeenCalledWith({ barcode: "HD002", category: "A", companyId: 4 });
    expect(created.body).toMatchObject({ id: 2, companyId: 4, barcode: "HD002" });

    const imported = responseHarness();
    await routes.get("POST /api/pending-barcodes/import")!(
      request({ body: { barcodes: [{ code: "HD003", grade: "B" }, "HD004"] } }),
      imported
    );
    expect(harness.storage.bulkCreatePendingBarcodes).toHaveBeenCalledWith([
      { companyId: 4, barcode: "HD003", category: null, grade: "B", origin: null, printed: false, used: false },
      { companyId: 4, barcode: "HD004", category: null, grade: null, origin: null, printed: false, used: false },
    ]);
    expect(imported.body).toMatchObject({ success: true, count: 2 });
  });

  it("validates barcode mutation payload shapes and ids", async () => {
    const invalidImport = responseHarness();
    await routes.get("POST /api/pending-barcodes/import")!(
      request({ body: { barcodes: "not-an-array" } }),
      invalidImport
    );
    expect(invalidImport.statusCode).toBe(400);

    const invalidPatch = responseHarness();
    await routes.get("PATCH /api/pending-barcodes/:id")!(request({ params: { id: "bad" } }), invalidPatch);
    expect(invalidPatch.statusCode).toBe(400);

    const invalidPrinted = responseHarness();
    await routes.get("PATCH /api/pending-barcodes/mark-printed")!(request({ body: { ids: "bad" } }), invalidPrinted);
    expect(invalidPrinted.statusCode).toBe(400);
  });

  it("creates categories once and rejects duplicate names", async () => {
    harness.storage.getBaleProductCategoryByName
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 10, name: "Tops" });
    harness.storage.createBaleProductCategory.mockResolvedValue({ id: 10, companyId: 4, name: "Tops" });

    const created = responseHarness();
    await routes.get("POST /api/bale-product-categories")!(request({ body: { name: "Tops" } }), created);
    expect(harness.categoryParse).toHaveBeenCalledWith({ name: "Tops", companyId: 4 });
    expect(created.body).toMatchObject({ id: 10, name: "Tops" });

    const duplicate = responseHarness();
    await routes.get("POST /api/bale-product-categories")!(request({ body: { name: "Tops" } }), duplicate);
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.body).toEqual({ message: 'Category "Tops" already exists' });
  });

  it("updates and deletes only existing category ids", async () => {
    harness.storage.getBaleProductCategoryById
      .mockResolvedValueOnce({ id: 10, name: "Tops" })
      .mockResolvedValueOnce(null);
    harness.storage.updateBaleProductCategory.mockResolvedValue({ id: 10, name: "Premium Tops" });

    const updated = responseHarness();
    await routes.get("PATCH /api/bale-product-categories/:id")!(
      request({ params: { id: "10" }, body: { name: "Premium Tops" } }),
      updated
    );
    expect(updated.body).toMatchObject({ name: "Premium Tops" });

    const missing = responseHarness();
    await routes.get("DELETE /api/bale-product-categories/:id")!(request({ params: { id: "11" } }), missing);
    expect(missing.statusCode).toBe(404);
    expect(harness.storage.deleteBaleProductCategory).not.toHaveBeenCalled();
  });

  it("derives an HMD article code from itemNumber and prevents duplicate article codes", async () => {
    harness.storage.getBaleProductByArticleCode
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 1, articleCode: "HMD07000" });
    harness.storage.createBaleProduct.mockImplementation(async (value) => ({ id: 1, ...value }));

    const created = responseHarness();
    await routes.get("POST /api/bale-products")!(request({ body: { itemNumber: 7, name: "Shirts" } }), created);
    expect(harness.productParse).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, articleCode: "HMD07000", code: "HMD07000" })
    );
    expect(created.body).toMatchObject({ id: 1, articleCode: "HMD07000" });

    const duplicate = responseHarness();
    await routes.get("POST /api/bale-products")!(
      request({ body: { articleCode: "HMD07000", name: "Duplicate" } }),
      duplicate
    );
    expect(duplicate.statusCode).toBe(409);
  });

  it("blocks cross-company product updates and deletes", async () => {
    harness.storage.getBaleProductById.mockResolvedValue({ id: 7, companyId: 99, name: "Other company" });

    const patch = responseHarness();
    await routes.get("PATCH /api/bale-products/:id")!(
      request({ params: { id: "7" }, body: { name: "Changed" } }),
      patch
    );
    expect(patch.statusCode).toBe(403);
    expect(harness.storage.updateBaleProduct).not.toHaveBeenCalled();

    const del = responseHarness();
    await routes.get("DELETE /api/bale-products/:id")!(request({ params: { id: "7" } }), del);
    expect(del.statusCode).toBe(403);
    expect(harness.storage.deleteBaleProduct).not.toHaveBeenCalled();
  });

  it("updates and deletes scoped products", async () => {
    harness.storage.getBaleProductById.mockResolvedValue({ id: 7, companyId: 4, name: "Shirts" });
    harness.storage.updateBaleProduct.mockResolvedValue({ id: 7, companyId: 4, name: "Premium Shirts" });

    const patch = responseHarness();
    await routes.get("PATCH /api/bale-products/:id")!(
      request({ params: { id: "7" }, body: { name: "Premium Shirts" } }),
      patch
    );
    expect(harness.productPartialParse).toHaveBeenCalledWith({ name: "Premium Shirts" });
    expect(patch.body).toMatchObject({ name: "Premium Shirts" });

    const del = responseHarness();
    await routes.get("DELETE /api/bale-products/:id")!(request({ params: { id: "7" } }), del);
    expect(del.body).toEqual({ success: true });
    expect(harness.storage.deleteBaleProduct).toHaveBeenCalledWith(7);
  });
});
