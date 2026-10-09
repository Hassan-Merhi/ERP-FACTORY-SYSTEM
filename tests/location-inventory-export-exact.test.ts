/**
 * The all-locations inventory export totals bale weights exactly and rounds
 * each cell half up from the exact value: one 163.825 kg bale shows 163.83 kg
 * (the float path rounded 163.82499… to 163.82).
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ d: null as any }));
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/helpers/exportVisibility", () => ({ getExportPriceVisibility: async () => ({ hideCost: false }) }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: () => unknown) => {
    const q: any = {};
    for (const step of ["where", "limit", "innerJoin", "orderBy"]) q[step] = () => q;
    q.then = (ok: any, bad: any) => Promise.resolve().then(value).then(ok, bad);
    return q;
  };
  const rows = (name: string) => {
    const d = h.d;
    if (name === "factory_settings") return [{ hideAvgCost: false }];
    if (name === "factory_bales") return d.bales;
    if (name === "customer_order_bales") return [];
    if (name === "locations")
      return [
        { id: 1, name: "A" },
        { id: 2, name: "B" },
      ];
    if (name === "factory_products") return d.products;
    if (name === "factory_categories")
      return [
        { id: 1, name: "Shirts" },
        { id: 2, name: "Wipers" },
      ];
    return [];
  };
  return { db: { select: () => ({ from: (t: any) => chain(() => rows(getTableName(t))) }) } };
});

import { registerFactoryLocationInventoryExportRoutes } from "../server/routes/factory/stock/locationInventoryExportRoutes";

describe("location inventory export", () => {
  it("rounds summary weights half up from the exact total", async () => {
    const ExcelJS = (await import("exceljs")).default;
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerFactoryLocationInventoryExportRoutes({
      get: (_path: string, _auth: unknown, h2: typeof handler) => {
        handler = h2;
      },
    } as never);
    h.d = {
      products: [{ id: 1, categoryId: 1, productionPrice: "10" }],
      bales: [
        {
          id: 1,
          erpLocationId: 1,
          productId: 1,
          productName: "Shirts",
          articleCode: "A",
          referenceNumber: "R1",
          weightKg: "163.825",
          costPerKg: "1",
          totalCost: "163.83",
          category: null,
        },
      ],
    };
    let buffer: Buffer | undefined;
    const res = {
      headersSent: false,
      setHeader: () => undefined,
      status: () => res,
      json: () => res,
      end: (value: Buffer) => {
        buffer = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 }, query: {}, headers: {} }, res);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer!);
    const summary = workbook.getWorksheet("Stock Summary")!;
    expect(summary.getRow(2).getCell(7).value).toBe(163.83);
    expect(summary.getRow(2).getCell(6).value).toBe(163.83);
  });
});
