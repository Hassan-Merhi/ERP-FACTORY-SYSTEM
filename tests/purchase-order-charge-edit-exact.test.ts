/**
 * Editing a PO charge (PATCH /api/purchase-orders/:id) writes the voucher,
 * container totals and container_charges from the same cents the PO row keeps.
 * purchase_orders.freight is numeric(20, 2), so Postgres stores "1.005" as 1.01
 * (half away from zero); the float path wrote parseFloat("1.005").toFixed(2),
 * which is "1.00", leaving the PO and its ledger a cent apart.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ writes: [] as [string, string, Record<string, unknown>][] }));

const po = {
  id: 11,
  companyId: 7,
  poNumber: "PO-11",
  containerId: 3,
  voucherId: 50,
  itemsTotal: "100.00",
  freight: "0",
  surcharge: "0",
  fumigation: "0",
  documentCharges: "0",
  discount: "0",
  otherCharges: "0",
  freightPaidBy: "supplier",
  freightParentAccountId: null,
  freightOwnAccountId: null,
};

// Perpetual inventory journals are covered by their own suite; this harness has no SQL executor.
vi.mock("../server/services/accounting/perpetualInventory/stockReceipts", () => ({
  syncPurchaseOrderGitTx: async () => null,
}));
vi.mock("../server/auth", () => {
  const pass = (_q: unknown, _s: unknown, next: () => void) => next();
  return { requireAuth: pass, requireRole: () => pass };
});
vi.mock("../server/routes/_helpers", () => ({ logAudit: async () => undefined }));
vi.mock("../server/storage", () => ({
  storage: {
    getPurchaseOrderByIdForCompany: async () => po,
    getContainerByIdForCompany: async () => ({ id: 3, containerNumber: "C3", status: "OPEN" }),
    updatePurchaseOrder: async (_id: number, updates: object) => ({ ...po, ...updates }),
    getParentCompanyId: async () => null,
    getAllPurchaseOrders: async () => [po],
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rows: Record<string, unknown[]> = {
    vouchers: [{ totalAmount: "100.00" }],
    voucher_entries: [
      { id: 1, ledgerAccountId: 10, debitAmount: "100.00", creditAmount: "0" },
      { id: 2, ledgerAccountId: 20, debitAmount: "0", creditAmount: "100.00" },
    ],
    containers: [{ containerNumber: "C3" }],
    // Wave 7: the edit locks and re-reads the PO inside its one transaction
    // (a getter: the mock factory runs before `po` is initialised).
    get purchase_orders() {
      return [po];
    },
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit", "returning", "for"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const record = (kind: string, table: never, values: Record<string, unknown>) => {
    harness.writes.push([kind, getTableName(table), values]);
    return chain([{ id: 1 }]);
  };
  const db: Record<string, unknown> = {
    select: () => ({ from: (table: never) => chain(rows[getTableName(table)] ?? []) }),
    update: (table: never) => ({ set: (values: Record<string, unknown>) => record("update", table, values) }),
    insert: (table: never) => ({ values: (values: Record<string, unknown>) => record("insert", table, values) }),
    delete: () => chain([]),
  };
  db.transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { db };
});

import { registerContainerFreightWriteRoutes } from "../server/routes/containers/containerFreightWriteRoutes";

async function patchPurchaseOrder(body: Record<string, unknown>) {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerContainerFreightWriteRoutes({
    patch: (path: string, ...handlers: never[]) => {
      if (path === "/api/purchase-orders/:id") handler = handlers.at(-1);
    },
    delete: () => undefined,
    post: () => undefined,
    get: () => undefined,
  } as never);
  harness.writes = [];
  let status = 200;
  await handler!(
    { params: { id: "11" }, body, session: { currentCompanyId: 7, currentRole: "Admin", userId: 1 } },
    { status: (code: number) => ((status = code), { json: () => undefined }), json: () => undefined }
  );
  return status;
}

const written = (kind: string, table: string) =>
  harness.writes.filter(([k, t]) => k === kind && t === table).map(([, , values]) => values);

describe("PO charge edit", () => {
  it("posts the voucher, container totals and charge row at the cents the PO stores", async () => {
    expect(await patchPurchaseOrder({ freight: "1.005" })).toBe(200);

    expect(written("update", "vouchers")).toEqual([{ totalAmount: "101.01" }]);
    expect(written("update", "voucher_entries")).toEqual([{ debitAmount: "101.01" }, { creditAmount: "101.01" }]);
    expect(written("update", "containers")).toEqual([
      { itemsTotal: "100.00", chargesTotal: "1.01", grandTotal: "101.01" },
    ]);
    expect(written("insert", "container_charges")).toEqual([{ containerId: 3, chargeType: "Freight", amount: "1.01" }]);
  });
});
