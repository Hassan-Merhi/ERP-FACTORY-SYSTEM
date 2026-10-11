/**
 * The line-items path of PATCH /api/purchase-orders/:id prices the PO from
 * exact amounts:
 * - a 1.005 freight is written as 1.01, the cents Postgres keeps for it (the
 *   float path wrote parseFloat("1.005").toFixed(2), which is "1.00");
 * - a blank charge counts as zero, as the edit form shows it (it was written
 *   as NaN, which Postgres numeric accepts);
 * - a non-numeric charge is rejected with 400 instead of being written as NaN.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ writes: [] as Array<[string, string, Record<string, unknown>]> }));
// Perpetual inventory journals are covered by their own suite; this harness has no SQL executor.
vi.mock("../server/services/accounting/perpetualInventory/stockReceipts", () => ({
  syncPurchaseOrderGitTx: async () => null,
}));
vi.mock("../server/routes/_helpers", () => ({ logAudit: async () => undefined }));
vi.mock("../server/routes/containers/containerHelpers", () => ({
  syncIntercoParentVoucher: async () => ({ found: true, updated: false }),
}));
vi.mock("../server/storage", () => ({
  storage: {
    getLineItemsByPO: async () => [],
    getContainerByIdForCompany: async () => undefined,
    getAllPurchaseOrders: async () => [],
    getParentCompanyId: async () => null,
    getPurchaseOrderByIdForCompany: async () => ({ id: 11 }),
    getSupplierById: async () => undefined,
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit", "for"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const rows: Record<string, unknown[]> = {
    containers: [{ id: 3, status: "OPEN" }],
    purchase_orders: [{ id: 11, containerId: 3 }],
  };
  const record = (kind: string, table: never, values: Record<string, unknown>) => {
    h.writes.push([kind, getTableName(table), values]);
    return chain([]);
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

import { applyPurchaseOrderItemsUpdate } from "../server/routes/containers/purchaseOrderItemsUpdate";

const existingPO = {
  id: 11,
  companyId: 7,
  poNumber: "PO-11",
  containerId: 3,
  voucherId: null,
  itemsTotal: "0",
  freight: "0",
  surcharge: "0",
  fumigation: "0",
  documentCharges: "0",
  discount: "0",
  otherCharges: "0",
  freightPaidBy: "supplier",
  chargesEdited: false,
};

const update = (body: Record<string, unknown>) =>
  applyPurchaseOrderItemsUpdate({ body: { items: [], ...body }, session: { userId: 1 } } as never, {
    id: 11,
    existingPO: existingPO as never,
  });

describe("purchase order items update", () => {
  beforeEach(() => {
    h.writes = [];
  });

  it("writes charges at the cents Postgres keeps and blanks as zero", async () => {
    await update({ freight: "1.005", fumigation: "" });
    const poUpdate = h.writes.find(([kind, table]) => kind === "update" && table === "purchase_orders")?.[2];
    expect(poUpdate).toMatchObject({ freight: "1.01", fumigation: "0.00", itemsTotal: "0.00" });
  });

  it("rejects a non-numeric charge before writing", async () => {
    await expect(update({ freight: "abc" })).rejects.toMatchObject({ statusCode: 400, message: "Invalid amount" });
    expect(h.writes).toEqual([]);
  });
});
