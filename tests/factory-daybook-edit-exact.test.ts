/**
 * Daybook edit routes compute exactly:
 * - voiding a RECEIPT-REPAY voucher restores 10.004 + 1.001 = 11.005 to the
 *   advance as 11.01, the cent Postgres keeps (the float path wrote 11.00);
 * - a cost edit whose FX rate does not parse answers 400 instead of writing
 *   NaN as the entry's USD amount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ d: null as any, writes: [] as unknown[] }));
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/factory/_helpers", () => ({
  writeDaybookEntry: async (_d: unknown, e: any) => void h.writes.push(["daybook", e]),
  recalculateContainerCosts: async () => h.d.recalc,
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: () => unknown) => {
    const q: any = {};
    for (const step of ["where", "orderBy", "limit"]) q[step] = () => q;
    q.returning = () => q;
    q.then = (ok: any, bad: any) => Promise.resolve().then(value).then(ok, bad);
    return q;
  };
  const strip = (v: any) => {
    const o: any = {};
    for (const [k, x] of Object.entries(v)) if (!(x instanceof Date)) o[k] = x;
    return o;
  };
  const db: any = {
    select: () => ({ from: (t: any) => chain(() => h.d.tables[getTableName(t)] ?? []) }),
    insert: (t: any) => ({
      values: (v: any) => {
        h.writes.push(["insert", getTableName(t), strip(v)]);
        return chain(() => [{ id: 99, ...v }]);
      },
    }),
    update: (t: any) => ({
      set: (v: any) => {
        h.writes.push(["update", getTableName(t), strip(v)]);
        return chain(() => [{ id: 1, ...v }]);
      },
    }),
    delete: (t: any) => ({
      where: () => {
        h.writes.push(["delete", getTableName(t)]);
        return Promise.resolve();
      },
    }),
  };
  db.transaction = async (fn: any) => fn(db);
  return { db };
});

import { registerFactoryDaybookEditRoutes } from "../server/routes/factory/docs-users/daybookEditRoutes";

type Handler = (req: unknown, res: unknown) => Promise<void>;
const handlers = new Map<string, Handler>();
const register = (method: string) => (path: string, _auth: unknown, handler: Handler) =>
  handlers.set(method + path, handler);
registerFactoryDaybookEditRoutes({
  get: register("GET"),
  put: register("PUT"),
  patch: register("PATCH"),
  delete: register("DELETE"),
} as never);
const session = { currentCompanyId: 7, userId: 1, currentRole: "admin" };
const response = () => ({
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
});

describe("daybook edits", () => {
  beforeEach(() => {
    h.writes = [];
  });

  it("restores an advance by the exact repayment when a repayment voucher is voided", async () => {
    h.d = {
      tables: {
        vouchers: [
          { id: 5, voucherType: "Receipt", voucherNumber: "RECEIPT-REPAY-6-1", currency: "USD", totalAmount: "1.00" },
        ],
        factory_advance_repayments: [{ id: 6, advanceId: 1, amount: "1.001" }],
        factory_worker_advances: [{ id: 1, amount: "50", remainingBalance: "10.004" }],
      },
    };
    const res = response();
    await handlers.get("DELETE/api/factory/daybook/entry/:id/void")!(
      { params: { id: "-5" }, session, headers: {} },
      res
    );
    expect(res.statusCode).toBe(200);
    const advanceUpdate = h.writes.find(
      (w) => Array.isArray(w) && w[0] === "update" && w[1] === "factory_worker_advances"
    ) as [string, string, Record<string, unknown>];
    expect(advanceUpdate[2]).toMatchObject({ remainingBalance: "11.01" });
  });

  it("rejects a cost edit whose FX rate does not parse", async () => {
    h.d = {
      recalc: { totalCost: 100, inclusiveCostPerKg: 1 },
      tables: {
        factory_daybook_entries: [
          { id: 7, txType: "FREIGHT", referenceId: 3, currencyCode: "XOF", fxRateToUsd: "0.0017", metaJson: "{}" },
        ],
        factory_containers: [
          { id: 3, containerNumber: "C3", currencyCode: "XOF", fxRateToUsd: "0.0017", fxRateConfirmed: true },
        ],
      },
    };
    const res = response();
    await handlers.get("PATCH/api/factory/daybook/:entryId/cost-edit")!(
      { params: { entryId: "7" }, session, headers: {}, body: { reason: "fix", newAmount: "10", newFxRate: "abc" } },
      res
    );
    expect(res.statusCode).toBe(400);
    expect(h.writes).toEqual([]);
  });
});
