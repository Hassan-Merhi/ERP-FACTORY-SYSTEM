/**
 * Production raw stock and ERP mix batches value kilograms exactly: 0.5 kg
 * at 4.35 is worth 2.175, written as "2.18". The float product
 * 2.1749999999999998 was written as "2.17".
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ inserts: [] as Array<{ table: string; values: Record<string, unknown> }> }));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/storage", () => ({ storage: {} }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) =>
    getTableName(table) === "production_raw_stock"
      ? [{ id: 1, containerId: 3, receivedKg: "1", usedKg: "0.5", costPerKg: "4.35" }]
      : [];
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "leftJoin", "orderBy", "for"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const client = {
    select: () => ({ from: (table: never) => chain(rowsFor(table)) }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
    insert: (table: never) => ({
      values: (values: Record<string, unknown>) => {
        state.inserts.push({ table: getTableName(table), values });
        return { returning: async () => [{ id: 50, ...values }] };
      },
    }),
  };
  return { db: { ...client, transaction: async (fn: (tx: typeof client) => unknown) => fn(client) } };
});

import { registerProductionRawStockRoutes } from "../server/routes/productionRawStockRoutes";

type Handler = (req: unknown, res: unknown) => Promise<void>;
const handlers = new Map<string, Handler>();
registerProductionRawStockRoutes({
  get: (path: string, ...rest: unknown[]) => handlers.set(`GET ${path}`, rest[rest.length - 1] as Handler),
  post: (path: string, ...rest: unknown[]) => handlers.set(`POST ${path}`, rest[rest.length - 1] as Handler),
} as never);

async function call(key: string, body: Record<string, unknown> = {}) {
  let result: unknown;
  const res = {
    status: () => res,
    json: (value: unknown) => {
      result = value;
      return res;
    },
  };
  await handlers.get(key)!({ session: { currentCompanyId: 7, userId: "u1" }, body, params: {} }, res);
  return result as never;
}

describe("production raw stock exact money", () => {
  beforeEach(() => {
    state.inserts = [];
  });

  it("values the remaining kilograms exactly", async () => {
    const rows: Array<Record<string, unknown>> = await call("GET /api/production-raw-stock");
    expect(rows[0]).toMatchObject({ remainingKg: "0.500", valueRemaining: "2.18" });
  });

  it("costs a mix batch's container sources exactly", async () => {
    await call("POST /api/mix-batches", { sources: [{ containerId: 3, weightKg: "0.5", costPerKg: "4.35" }] });
    expect(state.inserts.find((i) => i.table === "mix_batches")?.values).toMatchObject({
      totalWeightKg: "0.500",
      costPerKg: "4.3500",
      totalCost: "2.18",
    });
    expect(state.inserts.find((i) => i.table === "mix_batch_sources")?.values).toMatchObject({
      weightKg: "0.500",
      costPerKg: "4.3500",
      totalCost: "2.18",
    });
  });
});
