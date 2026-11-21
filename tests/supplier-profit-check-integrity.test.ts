import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readModuleFamily } from "../scripts/lib/readModuleFamily.mjs";

const harness = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../server/db", () => ({
  pool: { query: harness.query },
}));

import ExcelJS from "exceljs";
import { registerSupplierProfitAnalyzeRoutes } from "../server/routes/supplier-profit-check/analyze";
import { consolidateProfitSourceItems } from "../server/routes/supplier-profit-check/analysis-core";
import { registerSupplierProfitExportRoutes } from "../server/routes/supplier-profit-check/export";

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
  };
  return res;
}

function result(rows: unknown[]) {
  return Promise.resolve({ rows });
}

function exportRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (routePath: string, ...handlers: Handler[]) => routes.set(`GET ${routePath}`, handlers.at(-1)!),
    post: (routePath: string, ...handlers: Handler[]) => routes.set(`POST ${routePath}`, handlers.at(-1)!),
  };
  registerSupplierProfitExportRoutes(app, ((_req: any, _res: any, next: any) => next()) as any);
  return routes;
}

function workbookResponseHarness() {
  const res: any = {
    statusCode: 200,
    sent: undefined as Buffer | undefined,
    setHeader: vi.fn(),
    status: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn(),
    send: vi.fn((body: Buffer) => {
      res.sent = body;
      return res;
    }),
  };
  return res;
}

describe("Supplier Profit Check integrity", () => {
  const analyze = routeHarness();

  beforeEach(() => {
    harness.query.mockReset();
  });

  it("keeps one canonical source row per stock item and sums duplicate quantities", () => {
    const rows = consolidateProfitSourceItems([
      {
        id: 7,
        code: "MJS4110",
        name: "Shirt",
        stock_group_id: 2,
        stock_group_name: "Supplier",
        proforma_qty: "6",
        proforma_price: "100",
        proforma_barcode: "MJS4110",
      },
      {
        id: 7,
        code: "MJS4110",
        name: "Shirt",
        stock_group_id: 2,
        stock_group_name: "Supplier",
        proforma_qty: "6",
        proforma_price: "100",
        proforma_barcode: "ALIAS-MJS4110",
      },
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0].proforma_qty).toBe(12);
  });

  it("aggregates proforma lines after one-line-to-one-item resolution", async () => {
    harness.query.mockReturnValueOnce(result([{ id: 2 }])).mockReturnValueOnce(result([]));
    const res = responseHarness();

    await analyze(
      {
        session: { currentCompanyId: 4 },
        body: { supplierId: 2, sourceType: "proforma", proformaId: 31 },
      } as any,
      res
    );

    const sourceSql = String(harness.query.mock.calls[1]?.[0]);
    expect(sourceSql).toContain("JOIN LATERAL");
    // The resolution CTE is `source_rows` since unresolved proforma lines started being retained
    // instead of dropped by the join; the aggregation it feeds is what this test pins.
    expect(sourceSql).toContain("SUM(source_rows.qty)");
    expect(sourceSql).toContain("GROUP BY");
    expect(res.body).toEqual([]);
  });

  it("rejects foreign or non-OTW container ids before reading loaded items", async () => {
    harness.query.mockReturnValueOnce(result([{ id: 2 }])).mockReturnValueOnce(result([{ id: 10 }]));
    const res = responseHarness();

    await analyze(
      {
        session: { currentCompanyId: 4 },
        body: { supplierId: 2, sourceType: "otw_containers", containerIds: [10, 11] },
      } as any,
      res
    );

    expect(res.statusCode).toBe(400);
    expect(harness.query).toHaveBeenCalledTimes(2);
    expect(String(harness.query.mock.calls[1]?.[0])).toContain("company_id = $2");
    expect(String(harness.query.mock.calls[1]?.[0])).toContain("supplier_id = $3");
    expect(String(harness.query.mock.calls[1]?.[0])).toContain("status = 'OTW'");
  });

  it("keeps proforma replacement atomic and override routes company scoped", () => {
    const root = process.cwd();
    const proforma = fs.readFileSync(path.join(root, "server/routes/supplier-profit-check/proforma.ts"), "utf8");
    const overrides = fs.readFileSync(path.join(root, "server/routes/supplier-profit-check/po-overrides.ts"), "utf8");
    // export.ts is split; read it with the siblings extracted from it.
    const exportSource = readModuleFamily(path.join(root, "server/routes/supplier-profit-check/export.ts"));

    expect(proforma).toContain('client.query("BEGIN")');
    expect(proforma).toContain('client.query("COMMIT")');
    expect(proforma).toContain('client.query("ROLLBACK")');
    expect(proforma).toContain("resolveAndConsolidateItems");
    expect(overrides).toContain("si.company_id = $2");
    expect(overrides).toContain("po-overrides/bulk");
    expect(overrides).toContain("hasPoPrice");
    expect(overrides).toContain("hasAvgPrice");
    expect(exportSource).toContain("effectiveSellPrice");
    expect(exportSource).toContain("effectivePoPrice");
    expect(exportSource).toContain("landingCost");
  });

  it("keeps proforma lines whose barcode no longer resolves to a stock item", async () => {
    const handler = exportRoutes().get("GET /api/supplier-profit-check/proforma/:proformaId/export-supplier")!;
    harness.query
      .mockReturnValueOnce(result([{ id: 31, reference: "PF-31", notes: "", supplier_name: "Supplier A" }]))
      .mockReturnValueOnce(result([]));

    const res = workbookResponseHarness();
    await handler({ session: { currentCompanyId: 4 }, params: { proformaId: "31" } }, res);

    // An inner lateral join silently drops a saved line when its barcode was
    // renamed without an alias or its stock item was deleted, so the supplier
    // workbook and its grand total would omit legitimately ordered items.
    const linesQuery = String(harness.query.mock.calls[1]?.[0]);
    expect(linesQuery).toContain("LEFT JOIN LATERAL");
    expect(linesQuery).toContain("COALESCE(si.code, spl.barcode)");
    expect(linesQuery).toContain("COALESCE(si.name, spl.item_name)");
  });

  it("writes reconciliation totals at the end of the internal export", async () => {
    const handler = exportRoutes().get("POST /api/supplier-profit-check/export-internal")!;
    const res = workbookResponseHarness();
    await handler(
      {
        session: { currentCompanyId: 4 },
        body: {
          rows: [
            { code: "SH-1", name: "Shirts", qty: 3, effectiveSellPrice: 20, effectivePoPrice: 12, extraCostPerBale: 0 },
            { code: "SH-2", name: "Pants", qty: 2, effectiveSellPrice: 30, effectivePoPrice: 25, extraCostPerBale: 0 },
          ],
          supplierName: "Supplier A",
        },
      },
      res
    );

    expect(res.sent).toBeInstanceOf(Buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res.sent!);
    const sheet = workbook.getWorksheet("Analysis")!;
    const totalsRow = sheet.getRow(sheet.rowCount);

    expect(totalsRow.getCell(1).value).toBe("TOTALS");
    expect(totalsRow.getCell(2).value).toBe("2 items");
    expect(totalsRow.getCell(11).value).toBe(5); // qty ordered
    expect(totalsRow.getCell(12).value).toBe(86); // 3*12 + 2*25 landing cost
    expect(totalsRow.getCell(13).value).toBe(120); // 3*20 + 2*30 estimated sales
    expect(totalsRow.getCell(14).value).toBe(34); // 3*8 + 2*5 cost profit
  });
});
