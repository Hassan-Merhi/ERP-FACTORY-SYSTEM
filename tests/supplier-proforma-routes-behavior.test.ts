import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const insertResults: unknown[][] = [];
  const updateResults: unknown[][] = [];
  const executeResults: Array<{ rows: unknown[] }> = [];
  const transactionInserted: unknown[] = [];
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];
  const deletedTables: unknown[] = [];

  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const insert = vi.fn((table: unknown) => {
    const result = insertResults.shift() ?? [];
    const builder: any = {
      values: vi.fn((values: unknown) => {
        insertedValues.push({ table, values });
        return builder;
      }),
      returning: vi.fn(async () => result),
    };
    return builder;
  });

  const update = vi.fn((table: unknown) => {
    const result = updateResults.shift() ?? [];
    const builder: any = {
      set: vi.fn((values: unknown) => {
        updatedValues.push({ table, values });
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const del = vi.fn((table: unknown) => {
    deletedTables.push(table);
    const builder: any = {
      where: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  });

  // Raw company-scope ownership checks (suppliers.company_id lives outside the
  // drizzle table). Queued per test; by default the supplier resolves in scope
  // so pre-existing create flows exercise the insert path.
  const execute = vi.fn(async () => {
    return executeResults.shift() ?? { rows: [{ id: 2 }] };
  });

  const db: any = {
    select,
    insert,
    update,
    delete: del,
    execute,
    transaction: vi.fn(async (callback: (tx: any) => unknown) =>
      callback({
        insert: vi.fn((table: unknown) => ({
          values: vi.fn(async (values: unknown) => {
            transactionInserted.push({ table, values });
            return [];
          }),
        })),
      })
    ),
  };

  return {
    db,
    selectResults,
    insertResults,
    updateResults,
    executeResults,
    transactionInserted,
    insertedValues,
    updatedValues,
    deletedTables,
    logAudit: vi.fn(),
    buildAliasMap: vi.fn(),
    resolveBarcode: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/lib/parseId", () => ({
  parseId: (value: unknown) => {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  },
}));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/routes/_helpers", () => ({ logAudit: harness.logAudit }));
vi.mock("../server/routes/helpers/proformaBarcodeHelpers", () => ({
  buildAliasMap: harness.buildAliasMap,
  resolveBarcode: harness.resolveBarcode,
}));
vi.mock("../server/routes/container-loaded-items", () => ({ registerContainerLoadedItemsRoutes: vi.fn() }));
vi.mock("exceljs", () => ({ default: class Workbook {} }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  ne: (column: unknown, value: unknown) => ({ type: "ne", column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ type: "sql", strings, values }),
}));
vi.mock("@shared/schema", () => ({
  supplierProformas: {
    id: "supplierProformas.id",
    companyId: "supplierProformas.companyId",
    supplierId: "supplierProformas.supplierId",
  },
  supplierProformaLines: {
    id: "supplierProformaLines.id",
    proformaId: "supplierProformaLines.proformaId",
  },
  suppliers: { id: "suppliers.id", companyId: "suppliers.companyId" },
}));

import { registerSupplierProformaRoutes } from "../server/routes/supplierProformaRoutes";

type Handler = (req: any, res: any) => unknown;

function routesHarness() {
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
    put: register("PUT"),
  };
  registerSupplierProformaRoutes(app, (_req: any, _res: any, next: any) => next());
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 4, userId: "admin-1", username: "admin" },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as any;
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
    send: vi.fn((body?: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe("supplier proforma route behavior", () => {
  const routes = routesHarness();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.insertResults.splice(0);
    harness.updateResults.splice(0);
    harness.executeResults.splice(0);
    harness.transactionInserted.splice(0);
    harness.insertedValues.splice(0);
    harness.updatedValues.splice(0);
    harness.deletedTables.splice(0);
    harness.buildAliasMap.mockResolvedValue({ map: new Map([["ALT-1", "MAIN-1"]]) });
    harness.resolveBarcode.mockImplementation(
      (barcode: string, map: Map<string, string>) => map.get(barcode) ?? barcode
    );
  });

  it("lists supplier proformas in the selected company scope", async () => {
    harness.selectResults.push([{ id: 10, companyId: 4, supplierId: 2, reference: "PF-10" }]);
    const res = resHarness();
    await routes.get("GET /api/suppliers/:supplierId/proformas")!(req({ params: { supplierId: "2" } }), res);
    expect(res.body).toEqual([{ id: 10, companyId: 4, supplierId: 2, reference: "PF-10" }]);
  });

  it("rejects invalid ids and missing company scope before querying", async () => {
    const missingCompany = resHarness();
    await routes.get("GET /api/suppliers/:supplierId/proformas")!(
      req({ session: {}, params: { supplierId: "2" } }),
      missingCompany
    );
    expect(missingCompany.statusCode).toBe(400);

    const invalid = resHarness();
    await routes.get("GET /api/suppliers/:supplierId/proformas")!(req({ params: { supplierId: "bad" } }), invalid);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.body).toEqual({ message: "Invalid id" });
  });

  it("loads a scoped proforma together with its lines", async () => {
    harness.selectResults.push(
      [{ id: 10, companyId: 4, supplierId: 2, reference: "PF-10" }],
      [{ id: 101, proformaId: 10, barcode: "MAIN-1", qty: 3 }]
    );
    const res = resHarness();
    await routes.get("GET /api/suppliers/:supplierId/proformas/:proformaId")!(
      req({ params: { supplierId: "2", proformaId: "10" } }),
      res
    );
    expect(res.body).toMatchObject({ id: 10, lines: [{ id: 101, proformaId: 10, barcode: "MAIN-1", qty: 3 }] });
  });

  it("creates a proforma with canonical alias codes, sanitized decimals, and one atomic line transaction", async () => {
    harness.insertResults.push([{ id: 10, companyId: 4, supplierId: 2, reference: "PF-NEW", notes: null }]);
    harness.selectResults.push([
      { id: 101, proformaId: 10, barcode: "MAIN-1", qty: 3, weightPerBale: "45.5", pricePerBale: "1234.5" },
      { id: 102, proformaId: 10, barcode: "MAIN-2", qty: 1, weightPerBale: "0", pricePerBale: "0" },
    ]);
    const res = resHarness();

    await routes.get("POST /api/suppliers/:supplierId/proformas")!(
      req({
        params: { supplierId: "2" },
        body: {
          reference: "PF-NEW",
          lines: [
            {
              barcode: " ALT-1 ",
              itemName: " Shirts ",
              qty: "3",
              weightPerBale: "45.500 kg",
              pricePerBale: "$1,234.50",
            },
            { barcode: "MAIN-2", itemName: "Pants", qty: "1", weightPerBale: "N/A", pricePerBale: "1e9" },
          ],
        },
      }),
      res
    );

    expect(harness.buildAliasMap).toHaveBeenCalledWith(4);
    expect(harness.transactionInserted).toEqual([
      {
        table: expect.anything(),
        values: [
          {
            proformaId: 10,
            barcode: "MAIN-1",
            itemName: "Shirts",
            qty: 3,
            weightPerBale: "45.5",
            pricePerBale: "1234.5",
          },
          { proformaId: 10, barcode: "MAIN-2", itemName: "Pants", qty: 1, weightPerBale: "0", pricePerBale: "0" },
        ],
      },
    ]);
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, action: "create", tableName: "supplier_proformas", recordId: 10 })
    );
    expect(res.body).toMatchObject({ id: 10, reference: "PF-NEW", lines: expect.any(Array) });
  });

  it("reports a missing parent instead of failing the foreign key on create", async () => {
    harness.executeResults.push({ rows: [] });
    const res = resHarness();
    await routes.get("POST /api/suppliers/:supplierId/proformas")!(
      req({ params: { supplierId: "999" }, body: { reference: "PF-GHOST", lines: [] } }),
      res
    );
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ message: "Supplier not found" });
    expect(harness.db.insert).not.toHaveBeenCalled();
    // The ownership probe stays scoped to the active company: the supplier id
    // from the URL and the session company travel in the same check.
    expect(harness.db.execute).toHaveBeenCalledWith(expect.objectContaining({ type: "sql", values: [999, 4] }));
  });

  it("prevents adding lines to a proforma owned by another company", async () => {
    harness.selectResults.push([]);
    const res = resHarness();
    await routes.get("POST /api/suppliers/:supplierId/proformas/:proformaId/lines")!(
      req({ params: { supplierId: "2", proformaId: "10" }, body: { barcode: "MAIN-1", qty: 2 } }),
      res
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ message: "Access denied" });
    expect(harness.db.insert).not.toHaveBeenCalled();
  });

  it("adds a line and touches the parent proforma timestamp", async () => {
    harness.selectResults.push([{ id: 10, companyId: 4 }]);
    harness.insertResults.push([{ id: 105, proformaId: 10, barcode: "MAIN-1", itemName: "Shirts", qty: 4 }]);
    const res = resHarness();
    await routes.get("POST /api/suppliers/:supplierId/proformas/:proformaId/lines")!(
      req({
        params: { supplierId: "2", proformaId: "10" },
        body: { barcode: "MAIN-1", itemName: "Shirts", qty: "4", weightPerBale: "45", pricePerBale: "12" },
      }),
      res
    );
    expect(res.body).toMatchObject({ id: 105, qty: 4 });
    expect(harness.updatedValues).toContainEqual(
      expect.objectContaining({ values: expect.objectContaining({ updatedAt: expect.any(Date) }) })
    );
  });

  it("patches only the supplied line fields after company ownership is confirmed", async () => {
    harness.selectResults.push([{ id: 105, proformaId: 10 }], [{ id: 10, companyId: 4 }]);
    harness.updateResults.push([{ id: 105, proformaId: 10, itemName: "Premium Shirts", qty: 6 }], []);
    const res = resHarness();
    await routes.get("PATCH /api/supplier-proforma-lines/:lineId")!(
      req({ params: { lineId: "105" }, body: { itemName: "Premium Shirts", qty: "6" } }),
      res
    );
    expect(harness.updatedValues[0]).toMatchObject({ values: { itemName: "Premium Shirts", qty: 6 } });
    expect(res.body).toMatchObject({ id: 105, qty: 6 });
  });

  it("deletes a scoped proforma and writes permanent audit evidence", async () => {
    const res = resHarness();
    await routes.get("DELETE /api/suppliers/:supplierId/proformas/:proformaId")!(
      req({ params: { supplierId: "2", proformaId: "10" } }),
      res
    );
    expect(harness.deletedTables).toHaveLength(2);
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, action: "delete", tableName: "supplier_proformas", recordId: 10 })
    );
    expect(res.body).toEqual({ success: true });
  });
});
