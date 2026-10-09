/**
 * The broker statement export rounds each ledger cell half up from the
 * amount's decimal value: an amount of 1.005 exports as 1.01 (the float path
 * rounded 1.00499… to 1.00).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/factory/suppliers/broker/_helpers", () => ({
  buildBrokerStatement: async () => ({
    supplier: { name: "Broker" },
    currencyLedgers: [
      {
        currencyCode: "USD",
        rows: [{ date: "2026-01-01", type: "container", description: "C1", amount: 1.005, runningBalance: 1.005 }],
        totalContainers: 1,
        totalValue: "1.01",
        totalCommission: "0.00",
        totalFreight: "0.00",
        totalFxOut: "0.00",
        totalFxIn: "0.00",
        totalPaid: "0.00",
        netBalance: "1.01",
      },
    ],
  }),
}));

import { registerSupplierBrokerStatementRoutes } from "../server/routes/factory/suppliers/broker/statement";

describe("broker statement export", () => {
  it("rounds ledger amounts half up", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerSupplierBrokerStatementRoutes({
      get: (path: string, _auth: unknown, handler: (req: unknown, res: unknown) => Promise<void>) => {
        handlers.set(path, handler);
      },
    } as never);
    let buffer: Buffer | undefined;
    const res = {
      setHeader: () => res,
      status: () => res,
      json: () => res,
      send: (value: Buffer) => {
        buffer = value;
        return res;
      },
      end: (value: Buffer) => {
        buffer = value;
        return res;
      },
    };
    await handlers.get("/api/factory/suppliers/:id/broker-statement/export")!(
      { session: { currentCompanyId: 7 }, params: { id: "4" }, query: {}, headers: {} },
      res
    );
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer!);
    const values: unknown[] = [];
    workbook.getWorksheet("USD")!.eachRow((row) => {
      if (row.getCell(3).value === "C1") values.push(row.getCell(4).value, row.getCell(7).value);
    });
    expect(values).toEqual([1.01, 1.01]);
  });
});
