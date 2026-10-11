/**
 * POST /api/factory/supplier-fx-transfers allocates the transfer to the
 * supplier's containers oldest first, exactly: a container of 1.002 kg at
 * 0.325 is worth 0.32565, so a larger transfer allocates 0.3257 to it (the
 * float product 0.32564999… wrote 0.3256).
 */
import { describe, expect, it, vi } from "vitest";

const writes: unknown[] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/factory/_helpers", () => ({ writeDaybookEntry: async () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rows: Record<string, unknown[]> = {
    factory_suppliers: [{ id: 1, name: "Sup", parentId: null }],
    factory_containers: [{ id: 3, totalKg: "1.002", ratePerKg: "0.3250", freight: null }],
    factory_fx_allocations: [],
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "orderBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: never) => chain(rows[getTableName(table)] ?? []) }),
    insert: (table: never) => ({
      values: (value: Record<string, unknown>) => {
        if (getTableName(table) === "factory_supplier_fx_transfers") {
          return { returning: async () => [{ id: 50, ...value }] };
        }
        writes.push(value);
        return Promise.resolve();
      },
    }),
  };
  // The create runs in one transaction; the fake transaction is the same fake db.
  db.transaction = async (work: (tx: unknown) => Promise<unknown>) => work(db);
  return { db };
});

import { registerSupplierFxTransferRoutes } from "../server/routes/factory/suppliers/fx/transfers";

describe("supplier FX transfer allocation", () => {
  it("allocates the exact container value", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    const register =
      (method: string) => (path: string, _auth: unknown, handler: (req: unknown, res: unknown) => Promise<void>) =>
        handlers.set(`${method} ${path}`, handler);
    registerSupplierFxTransferRoutes({
      get: register("GET"),
      post: register("POST"),
      delete: register("DELETE"),
    } as never);
    const res = { status: () => res, json: () => res };
    await handlers.get("POST /api/factory/supplier-fx-transfers")!(
      {
        session: { currentCompanyId: 7 },
        body: {
          fromSupplierId: 1,
          toSupplierId: 2,
          fromCurrencyCode: "XOF",
          fromAmount: "100.0000",
          fxRateToUsd: "0.0017",
          toAmountUsd: "0.1700",
          date: "2026-05-01",
        },
      },
      res
    );
    expect(writes).toEqual([[expect.objectContaining({ containerId: 3, allocatedAmount: "0.3257" })]]);
  });
});
