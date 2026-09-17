import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.query },
}));

import { registerSupplierProfitAnalyzeRoutes } from "../server/routes/supplier-profit-check/analyze";

type Handler = (req: any, res: any) => unknown;

function routeHarness(): Handler {
  let handler: Handler | undefined;
  const app: any = {
    post: (_path: string, ...handlers: Handler[]) => {
      handler = handlers.at(-1);
    },
  };
  registerSupplierProfitAnalyzeRoutes(app, ((_req: any, _res: any, next: any) => next()) as any);
  if (!handler) throw new Error("analyze route was not registered");
  return handler;
}

function req(body: Record<string, unknown>) {
  return {
    session: { currentCompanyId: 4 },
    body,
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
  };
  return res;
}

function result(rows: unknown[]) {
  return Promise.resolve({ rows });
}

describe("supplier profit check company scope", () => {
  const analyze = routeHarness();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.query.mockReset();
  });

  it("rejects a supplier outside the active company and linked parent before loading profit data", async () => {
    harness.query.mockReturnValueOnce(result([]));
    const res = resHarness();

    await analyze(req({ supplierId: 2, sourceType: "all" }), res);

    expect(res.statusCode).toBe(404);
    expect(harness.query).toHaveBeenCalledTimes(1);
  });

  it("keeps a selected proforma scoped to company and supplier and preserves unresolved source qty", async () => {
    harness.query
      .mockReturnValueOnce(result([{ id: 2, company_id: 4, stock_group_id: null }]))
      .mockReturnValueOnce(
        result([
          {
            id: 7,
            code: "SH-1",
            name: "Shirts",
            stock_group_id: 5,
            stock_group_name: "Group A",
            proforma_qty: "3",
            proforma_price: "12",
            proforma_barcode: "SH-1",
            unresolved: false,
          },
          {
            id: -91,
            code: "LEGACY-1",
            name: "Legacy supplier item",
            stock_group_id: null,
            stock_group_name: null,
            proforma_qty: "500",
            proforma_price: "30",
            proforma_barcode: "LEGACY-1",
            unresolved: true,
          },
        ])
      )
      .mockReturnValueOnce(result([]))
      .mockReturnValueOnce(result([]))
      .mockReturnValueOnce(result([]))
      .mockReturnValueOnce(result([]))
      .mockReturnValueOnce(result([]));
    const res = resHarness();

    await analyze(req({ supplierId: 2, sourceType: "proforma", proformaId: 31 }), res);

    expect(harness.query.mock.calls[1]?.[1]).toEqual([31, 4, 2]);
    expect(res.body).toHaveLength(2);
    expect(res.body[0].stockItemId).toBe(7);
    expect(res.body[0].proformaQty).toBe(3);
    expect(res.body[1]).toMatchObject({
      stockItemId: -91,
      code: "LEGACY-1",
      proformaQty: 500,
      poPrice: 30,
      unresolved: true,
    });
  });

  it("uses the active company's stock group for a locally owned supplier", async () => {
    harness.query
      .mockReturnValueOnce(result([{ id: 2, company_id: 4, stock_group_id: 5 }]))
      .mockReturnValueOnce(result([]));
    const res = resHarness();

    await analyze(req({ supplierId: 2, sourceType: "all" }), res);

    expect(harness.query.mock.calls[0]?.[1]).toEqual([2, 4]);
    expect(harness.query.mock.calls[1]?.[1]).toEqual([4, 5]);
    expect(res.body).toHaveLength(0);
  });

  it("maps a linked parent supplier stock group into the active company by code", async () => {
    harness.query
      .mockReturnValueOnce(result([{ id: 2, company_id: 1, stock_group_id: 50 }]))
      .mockReturnValueOnce(result([{ id: 7 }]))
      .mockReturnValueOnce(result([]));
    const res = resHarness();

    await analyze(req({ supplierId: 2, sourceType: "all" }), res);

    expect(harness.query.mock.calls[1]?.[1]).toEqual([4, 50, 1]);
    expect(harness.query.mock.calls[2]?.[1]).toEqual([4, 7]);
    expect(res.body).toHaveLength(0);
  });
});
