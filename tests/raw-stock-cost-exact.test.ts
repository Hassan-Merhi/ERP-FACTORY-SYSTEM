/**
 * Raw-stock cost corrections and deductions compute in exact decimals.
 * - update-cost (retired in phase 19 C, 410) wrote each open mix-batch
 *   source's totalCost over binary floats.
 * - deduct-received and the adjustment route let a non-numeric kg through
 *   (NaN <= 0 is false): one went on to post NaN daybook amounts, the other
 *   stored kg = 'NaN', which Postgres numeric accepts and every SUM then spreads.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  rows: {} as Record<string, unknown[]>,
  writes: [] as [string, string, Record<string, unknown>][],
  daybook: [] as unknown[],
}));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/services/factory/rawStockLockedRate", () => ({ getLockedSupplierRate: async () => 0.35 }));
vi.mock("../server/routes/factory/_helpers", () => ({
  writeDaybookEntry: async (_tx: unknown, entry: unknown) => harness.daybook.push(entry),
  getOrFetchFxRateToUsd: async () => "1",
  getOrCreateLedgerAccount: async () => 77,
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin", "orderBy", "limit", "groupBy", "returning"])
      q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const record = (kind: string, table: never, values: Record<string, unknown>) => {
    harness.writes.push([kind, getTableName(table), values]);
    return chain([{ id: 1 }]);
  };
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: never) => chain(harness.rows[getTableName(table)] ?? []) }),
    update: (table: never) => ({ set: (values: Record<string, unknown>) => record("update", table, values) }),
    insert: (table: never) => ({ values: (values: Record<string, unknown>) => record("insert", table, values) }),
    delete: () => chain([]),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

import { registerRawStockReceiptRoutes } from "../server/routes/factory/raw-stock/rawStockReceiptRoutes";
import { registerRawStockAdjRoutes } from "../server/routes/factory/raw-stock/rawStockAdjRoutes";

async function post(path: string, body: Record<string, unknown>) {
  const handlers: Record<string, (req: unknown, res: unknown) => Promise<unknown>> = {};
  const register = (route: string, ...chain: never[]) => (handlers[route] = chain.at(-1)!);
  registerRawStockReceiptRoutes({ get: register, post: register } as never);
  registerRawStockAdjRoutes({ get: register, post: register, delete: register, patch: register } as never);
  harness.writes = [];
  harness.daybook = [];
  let status = 200;
  await handlers[path](
    { body, session: { factoryCompanyId: 7 }, headers: {} },
    { status: (code: number) => ((status = code), { json: () => undefined }), json: () => undefined }
  );
  return status;
}

describe("raw stock cost routes", () => {
  // Phase 19 C (F2): update-cost is retired (410); costs change only through the reviewed re-cost.
  it("refuses the retired supplier cost update and writes nothing", async () => {
    harness.rows = {
      factory_raw_stock: [{ id: 1 }],
      factory_mix_batch_sources: [{ id: 5, mixBatchId: 10, weightKg: "100.5", costPerKg: "0.35" }],
    };
    expect(await post("/api/factory/raw-stock/update-cost", { supplierId: 1, newCostPerKg: "0.35" })).toBe(410);
    expect(harness.writes).toEqual([]);
  });

  it("rejects a non-numeric kg instead of posting NaN", async () => {
    harness.rows = { factory_raw_stock: [{ id: 1, receivedKg: "50", usedKg: "0" }] };
    expect(await post("/api/factory/raw-stock/deduct-received", { supplierId: 1, kg: "abc", costPerKg: "2" })).toBe(
      400
    );
    expect(harness.daybook).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it("rejects a non-numeric adjustment kg instead of storing NaN", async () => {
    harness.rows = {};
    const body = { type: "ADD", kg: "abc", supplierId: 1, date: "2026-03-01" };
    expect(await post("/api/factory/raw-stock/adjustment", body)).toBe(400);
    expect(harness.writes).toEqual([]);
  });

  it("writes the manual purchase voucher as kg × locked rate, rounded to the cent", async () => {
    harness.rows = { factory_suppliers: [{ name: "Supplier" }] };
    const body = { type: "ADD", kg: "100.5", supplierId: 1, date: "2026-03-01", createVoucher: true };
    expect(await post("/api/factory/raw-stock/adjustment", body)).toBe(200);
    const entries = harness.writes.filter(([kind, table]) => kind === "insert" && table === "voucher_entries");
    // Normalized factory entries store the USD amounts at the ledger's 6-decimal scale.
    expect(entries.map(([, , values]) => [values.debitAmount, values.creditAmount])).toEqual([
      ["35.180000", "0.000000"],
      ["0.000000", "35.180000"],
    ]);
  });
});
