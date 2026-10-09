/**
 * The supplier usage report works in exact kilograms: 0.3 kg received
 * before the period with 0.1 kg used leaves an opening balance of 0.2 (the
 * float difference was 0.19999999999999998).
 */
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({ summaries: [] as Array<Record<string, unknown>> }));
vi.mock("../server/routes/factory/_helpers", () => ({ getUserHideAllCosts: async () => false }));
vi.mock("../server/routes/factory-reports/_helpers", () => ({
  generateEmptyExcel: vi.fn(),
  generateEmptyPdf: vi.fn(),
  generateExcel: vi.fn(),
  generatePdf: vi.fn(async (_res: unknown, _name: string, _from: string, _to: string, summaries: never) => {
    captured.summaries = summaries;
  }),
  writeDaybookEntry: vi.fn(),
}));

import { getTableName } from "drizzle-orm";
import { registerFactorySupplierUsageReportRoutes } from "../server/routes/factory-reports/supplier-usage";

const rowsFor = (table: never) => {
  switch (getTableName(table)) {
    case "companies":
      return [{ id: 7, name: "Factory" }];
    case "factory_containers":
      return [{ id: 1, supplierId: 3, containerNumber: "C-1" }];
    case "factory_raw_stock":
      return [
        {
          containerId: 1,
          receivedKg: "0.3",
          usedKg: "0.1",
          costPerKg: "0",
          costPerKgUsd: "1.1",
          offloadedAt: "2026-08-01T00:00:00Z",
          createdAt: null,
        },
        {
          containerId: 1,
          receivedKg: "0.2",
          usedKg: "0",
          costPerKg: "2.2",
          costPerKgUsd: null,
          offloadedAt: "2026-09-02T00:00:00Z",
          createdAt: null,
        },
      ];
    case "factory_suppliers":
      return [{ id: 3, name: "Supplier" }];
    default:
      return [];
  }
};
const chain = (value: unknown) => {
  const q: Record<string, unknown> = {};
  for (const step of ["where", "orderBy"]) q[step] = () => q;
  q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  return q;
};
const db = { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) };

describe("supplier usage report", () => {
  it("keeps supplier kilograms and costs exact", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerFactorySupplierUsageReportRoutes(
      {
        post: (_path: string, _auth: unknown, h: typeof handler) => {
          handler = h;
        },
      } as never,
      (() => undefined) as never,
      db as never
    );
    await handler(
      { body: { companyId: 7, startDate: "2026-09-01", endDate: "2026-09-30", format: "pdf" }, session: {} },
      { status: () => ({ json: () => undefined }) }
    );

    expect(captured.summaries).toEqual([
      expect.objectContaining({
        openingBalance: 0.2,
        totalPurchasedKg: 0.2,
        remaining: 0.4,
        avgCostPerKg: 1.65,
        totalCost: 0.33,
      }),
    ]);
  });
});
