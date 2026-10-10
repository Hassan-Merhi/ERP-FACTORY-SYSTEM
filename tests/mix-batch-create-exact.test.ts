/**
 * POST /api/factory/mix-batches (create) draws source weight from raw stock
 * exactly: 0.3 kg drawn from containers holding 0.1 kg and 1 kg debits 0.1 and
 * 0.2 kg (the float path debited 0.19999999999999998), and a source weight
 * that does not parse answers 400 instead of adding NaN to usedKg.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writes: [] as Array<[string, string, Record<string, unknown>]> }));
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/helpers/auditHelpers", () => ({ logAudit: async () => undefined }));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: async () => undefined }));
vi.mock("../server/services/factory/rawStockStableCost", () => ({
  getStableSupplierCost: async () => ({
    rows: [
      { id: 10, containerId: 30, receivedKg: 0.1, usedKg: 0 },
      { id: 11, containerId: 31, receivedKg: 1, usedKg: 0 },
    ],
  }),
}));
// Wave 11: the route prices sources through baleCostBasis (the supplier's
// persisted locked rate, else the container's landed USD cost) instead of
// getLockedSupplierRate; the rate is stubbed there now. These tests pin weights.
vi.mock("../server/services/factory/baleCostBasis", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/factory/baleCostBasis")>();
  const { default: Decimal } = await import("decimal.js");
  return {
    ...actual,
    supplierLockedUsdRate: async () => new Decimal(0.35),
    containerUsdRate: async () => null,
    rawSourceUsdRate: async () => ({ rate: new Decimal(0.35), basis: "supplier-locked" }),
  };
});
vi.mock("../server/services/accounting/perpetualInventory/cutover", () => ({
  isPerpetualInventoryActive: async () => false,
  getInventoryCutover: async () => null,
}));
vi.mock("../server/db", async () => {
  const { getTableName, SQL } = await import("drizzle-orm");
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "for", "returning"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const batch = { id: 1, batchCode: "MB1", name: null, totalWeightKg: "0", totalCost: "0", usedKg: "0" };
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: never) => chain(getTableName(table) === "factory_mix_batches" ? [batch] : []) }),
    update: (table: never) => ({
      set: (values: Record<string, unknown>) => {
        const shown = Object.fromEntries(
          Object.entries(values).map(([key, value]) => [
            key,
            value instanceof SQL ? dialect.sqlToQuery(value).params.map(String) : value,
          ])
        );
        h.writes.push(["update", getTableName(table), shown]);
        return chain([batch]);
      },
    }),
    insert: () => ({ values: () => chain([batch]) }),
    delete: () => ({ where: async () => undefined }),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

import { registerFactoryMixBatchCreateRoutes } from "../server/routes/factory/mix-batches/create";

async function patch(body: Record<string, unknown>) {
  let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
  registerFactoryMixBatchCreateRoutes({
    post: (_path: string, _auth: unknown, h2: typeof handler) => {
      handler = h2;
    },
  } as never);
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(value: unknown) {
      this.body = value;
      return this;
    },
  };
  await handler({ session: { currentCompanyId: 7, userId: 1 }, headers: {}, body }, res);
  return res;
}

describe("mix batch create", () => {
  beforeEach(() => {
    h.writes = [];
  });

  it("debits raw stock by exact weights", async () => {
    const res = await patch({ supplierSources: [{ supplierId: 2, weightKg: "0.3" }] });
    expect(res.statusCode).toBe(200);
    const rawStockDebits = h.writes.filter(([, table]) => table === "factory_raw_stock").map(([, , v]) => v.usedKg);
    expect(rawStockDebits).toEqual([["0.1"], ["0.2"]]);
  });

  it("rejects a source weight that does not parse", async () => {
    const res = await patch({ supplierSources: [{ supplierId: 2, weightKg: "abc" }] });
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "Invalid amount" });
    expect(h.writes).toEqual([]);
  });
});
