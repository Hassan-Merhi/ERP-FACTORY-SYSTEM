/**
 * POST /api/purchase-orders/:id/sync-parent-voucher writes the PO voucher from
 * exact totals. The PO columns are numeric(20, 2), which hold amounts a binary
 * float cannot: an items total of 12345678901234567.89 was written as
 * 12345678901234568.00 by the float path.
 */
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writes: [] as Array<[string, string, Record<string, unknown>]> }));
vi.mock("../server/auth", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return { requireAuth: pass, requireNonPOS: pass };
});
vi.mock("../server/storage", () => ({
  storage: {
    getParentCompanyId: async () => null,
    getPurchaseOrderByIdForCompany: async () => ({
      id: 11,
      companyId: 7,
      poNumber: "PO-11",
      containerId: null,
      voucherId: 50,
      itemsTotal: "12345678901234567.89",
      freight: "10.00",
      surcharge: "0",
      fumigation: "0",
      documentCharges: "0",
      discount: "0",
      otherCharges: "0",
      freightPaidBy: "parent",
      freightParentAccountId: 9,
    }),
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const entries = [
    { id: 1, ledgerAccountId: 10, debitAmount: "1.00", creditAmount: "0" },
    { id: 2, ledgerAccountId: 20, debitAmount: "0", creditAmount: "1.00" },
  ];
  const record = (kind: string, table: never, values: Record<string, unknown>) => {
    h.writes.push([kind, getTableName(table), values]);
    return chain([]);
  };
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: never) => chain(getTableName(table) === "voucher_entries" ? entries : []) }),
    update: (table: never) => ({ set: (values: Record<string, unknown>) => record("update", table, values) }),
    insert: (table: never) => ({ values: (values: Record<string, unknown>) => record("insert", table, values) }),
    delete: () => chain([]),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

import { registerContainerFreightReadRoutes } from "../server/routes/containers/containerFreightReadRoutes";

describe("purchase order freight sync", () => {
  it("writes the voucher from exact PO totals", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    const register =
      (method: string) =>
      (path: string, ...chain: Array<(req: unknown, res: unknown) => Promise<void>>) =>
        handlers.set(`${method} ${path}`, chain[chain.length - 1]);
    registerContainerFreightReadRoutes({ get: register("GET"), post: register("POST") } as never);
    let body: Record<string, unknown> | undefined;
    const res = {
      status: () => res,
      json: (value: Record<string, unknown>) => {
        body = value;
        return res;
      },
    };
    await handlers.get("POST /api/purchase-orders/:id/sync-parent-voucher")!(
      { session: { currentCompanyId: 7 }, params: { id: "11" } },
      res
    );

    expect(body).toMatchObject({ updated: true, amount: "12345678901234577.89" });
    expect(h.writes).toEqual(
      expect.arrayContaining([
        ["update", "voucher_entries", expect.objectContaining({ debitAmount: "12345678901234577.89" })],
        ["update", "voucher_entries", expect.objectContaining({ creditAmount: "12345678901234567.89" })],
        ["insert", "voucher_entries", expect.objectContaining({ creditAmount: "10.00", ledgerAccountId: 9 })],
      ])
    );
  });
});
