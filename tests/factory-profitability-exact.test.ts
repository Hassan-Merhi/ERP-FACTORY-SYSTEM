/**
 * Factory profitability values bales and containers exactly: 1.3 kg at a
 * labour rate of 0.35/kg is 0.455, which rounds to 0.46 (the float product
 * was 0.45499999999999996 and rounded to 0.45).
 */
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import { registerFactoryProfitabilityRoutes } from "../server/routes/factory-intelligence/profitability";

const rowsFor = (table: never) => {
  switch (getTableName(table)) {
    case "factory_settings":
      return [{ laborCostPerKg: "0.35", overheadPerKg: "0" }];
    case "factory_bales":
      return [{ id: 11, referenceNumber: "B-1", productName: "Mix", weightKg: "1.3", totalCost: "0", mixBatchId: 5 }];
    case "customer_order_bales":
      return [{ baleId: 11, priceUsed: "1" }];
    case "factory_containers":
      return [{ id: 3, containerNumber: "C-1" }];
    case "factory_mix_batch_sources":
      return [{ mixBatchId: 5, containerId: 3 }];
    default:
      return [];
  }
};
const chain = (value: unknown) => {
  const q: Record<string, unknown> = {};
  q.where = () => q;
  q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  return q;
};
const db = { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) };

async function call(path: string) {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  registerFactoryProfitabilityRoutes(
    {
      get: (p: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => handlers.set(p, h),
    } as never,
    (() => undefined) as never,
    db as never
  );
  let body: unknown;
  const res = {
    status: () => res,
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };
  await handlers.get(path)!({ query: { from: "2026-09-01", to: "2026-09-30" }, session: { currentCompanyId: 7 } }, res);
  return body;
}

describe("factory profitability", () => {
  it("costs bale labour exactly", async () => {
    expect(await call("/api/factory/profitability/bales")).toEqual([
      expect.objectContaining({
        baleId: 11,
        weightKg: 1.3,
        laborCost: 0.46,
        totalCost: 0.46,
        salePrice: 1,
        profit: 0.55,
      }),
    ]);
  });

  it("costs container labour exactly", async () => {
    expect(await call("/api/factory/profitability/containers")).toEqual([
      { containerId: 3, containerNumber: "C-1", totalCost: 0.46, totalRevenue: 1, profit: 0.55, marginPct: 54.5 },
    ]);
  });
});
