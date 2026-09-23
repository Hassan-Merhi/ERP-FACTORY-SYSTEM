import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    txUpdates: [] as Array<{ table: unknown; values: unknown }>,
    txInserts: [] as Array<{ table: unknown; values: unknown }>,
    txDeletes: [] as unknown[],
  };

  function mutation(table: unknown, kind: "update" | "insert" | "delete") {
    const builder: any = {
      set: vi.fn((values: unknown) => {
        state.txUpdates.push({ table, values });
        return builder;
      }),
      values: vi.fn(async (values: unknown) => {
        state.txInserts.push({ table, values });
        return [];
      }),
      where: vi.fn(async () => []),
    };
    if (kind === "delete") state.txDeletes.push(table);
    return builder;
  }

  const tx = {
    delete: vi.fn((table: unknown) => mutation(table, "delete")),
    insert: vi.fn((table: unknown) => mutation(table, "insert")),
    update: vi.fn((table: unknown) => mutation(table, "update")),
    select: vi.fn(() => {
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        // Row locks (limit(1).for("update")) return the purchase order as the
        // route saw it; the fixtures have no container, so only the PO is locked.
        limit: vi.fn(() => ({ for: vi.fn(async () => [{ id: 10, containerId: null }]) })),
        then: (resolve: (value: unknown[]) => unknown) => Promise.resolve([]).then(resolve),
      };
      return builder;
    }),
  };

  const db = {
    transaction: vi.fn(async (fn: (txArg: typeof tx) => Promise<unknown>) => fn(tx)),
  };

  const storage = {
    getLineItemsByPO: vi.fn(),
    getContainerByIdForCompany: vi.fn(),
    getAllPurchaseOrders: vi.fn(),
    getParentCompanyId: vi.fn(),
    getPurchaseOrderByIdForCompany: vi.fn(),
    getSupplierById: vi.fn(),
  };

  return {
    state,
    tx,
    db,
    storage,
    logAudit: vi.fn(async () => undefined),
    syncIntercoParentVoucher: vi.fn(async () => ({ found: true })),
    loggerWarn: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/routes/_helpers", () => ({ logAudit: harness.logAudit }));
vi.mock("../server/routes/containers/containerHelpers", () => ({
  syncIntercoParentVoucher: harness.syncIntercoParentVoucher,
}));
vi.mock("../server/lib/logger", () => ({
  logger: { warn: harness.loggerWarn, info: vi.fn(), error: vi.fn() },
}));

import { applyPurchaseOrderItemsUpdate } from "../server/routes/containers/purchaseOrderItemsUpdate";

describe("Phase 33 3C purchase-order item repricing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.txUpdates.splice(0);
    harness.state.txInserts.splice(0);
    harness.state.txDeletes.splice(0);
    harness.storage.getParentCompanyId.mockResolvedValue(7);
    harness.storage.getContainerByIdForCompany.mockResolvedValue(null);
    harness.storage.getAllPurchaseOrders.mockResolvedValue([]);
    harness.storage.getSupplierById.mockResolvedValue({
      id: 4,
      legalName: "Supplier A",
      code: "SUP-A",
    });
  });

  it("preserves omitted quantity/rate from the stored line and reprices the PO", async () => {
    harness.storage.getLineItemsByPO
      .mockResolvedValueOnce([
        {
          id: 21,
          stockItemId: 501,
          itemName: "Old item",
          quantity: "4",
          rate: "2.50",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 31,
          poId: 10,
          stockItemId: 501,
          itemName: "Renamed item",
          quantity: "4",
          rate: "2.50",
          lineTotal: "10.00",
        },
      ]);
    harness.storage.getPurchaseOrderByIdForCompany.mockResolvedValue({
      id: 10,
      companyId: 7,
      poNumber: "PO-10",
      supplierId: 4,
      containerId: null,
      voucherId: null,
      currency: "USD",
      status: "Draft",
      itemsTotal: "10.00",
      freight: "0.00",
      surcharge: "0.00",
      fumigation: "0.00",
      documentCharges: "0.00",
      discount: "0.00",
      otherCharges: "0.00",
      chargesEdited: false,
      freightPaidBy: "supplier",
      freightOwnAccountId: null,
      freightParentAccountId: null,
    });

    const existingPO = {
      id: 10,
      companyId: 7,
      poNumber: "PO-10",
      supplierId: 4,
      containerId: null,
      voucherId: null,
      currency: "USD",
      status: "Draft",
      itemsTotal: "10.00",
      freight: "0.00",
      surcharge: "0.00",
      fumigation: "0.00",
      documentCharges: "0.00",
      discount: "0.00",
      otherCharges: "0.00",
      chargesEdited: false,
      freightPaidBy: "supplier",
      freightOwnAccountId: null,
      freightParentAccountId: null,
    } as any;

    const req = {
      body: { items: [{ id: "21", itemName: "Renamed item" }] },
      session: { userId: "admin", username: "Admin", currentCompanyId: 7 },
    } as any;

    const result = await applyPurchaseOrderItemsUpdate(req, {
      id: 10,
      existingPO,
    });

    expect(harness.state.txInserts[0]?.values).toEqual([
      {
        poId: 10,
        stockItemId: 501,
        itemName: "Renamed item",
        quantity: "4",
        rate: "2.50",
        lineTotal: "10.00",
      },
    ]);
    expect(
      harness.state.txUpdates.some(
        ({ values }) =>
          (values as Record<string, unknown>)?.itemsTotal === "10.00" &&
          (values as Record<string, unknown>)?.chargesEdited === false
      )
    ).toBe(true);
    expect(harness.syncIntercoParentVoucher).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      id: 10,
      supplierName: "Supplier A",
      supplierCode: "SUP-A",
      items: [expect.objectContaining({ itemName: "Renamed item", lineTotal: "10.00" })],
    });
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 7,
        action: "update",
        tableName: "purchase_orders",
        recordId: 10,
      })
    );
  });

  it("honors explicit zero charges and marks charges as edited", async () => {
    harness.storage.getLineItemsByPO
      .mockResolvedValueOnce([
        {
          id: 21,
          stockItemId: 501,
          itemName: "Item",
          quantity: "2",
          rate: "5",
        },
      ])
      .mockResolvedValueOnce([]);
    harness.storage.getPurchaseOrderByIdForCompany.mockResolvedValue({
      id: 10,
      companyId: 7,
      supplierId: 4,
      containerId: null,
    });

    const existingPO = {
      id: 10,
      companyId: 7,
      poNumber: "PO-10",
      supplierId: 4,
      containerId: null,
      voucherId: null,
      currency: "USD",
      status: "Draft",
      itemsTotal: "10.00",
      freight: "12.00",
      surcharge: "4.00",
      fumigation: "3.00",
      documentCharges: "2.00",
      discount: "1.00",
      otherCharges: "6.00",
      chargesEdited: false,
      freightPaidBy: "supplier",
      freightOwnAccountId: null,
      freightParentAccountId: null,
    } as any;

    await applyPurchaseOrderItemsUpdate(
      {
        body: {
          items: [{ id: 21, quantity: 2, rate: 5 }],
          freight: 0,
          surcharge: 0,
          fumigation: 0,
          documentCharges: 0,
          discount: 0,
          otherCharges: 0,
        },
        session: { userId: "admin", username: "Admin", currentCompanyId: 7 },
      } as any,
      { id: 10, existingPO }
    );

    expect(
      harness.state.txUpdates.some(({ values }) => {
        const row = values as Record<string, unknown>;
        return (
          row.freight === "0.00" &&
          row.surcharge === "0.00" &&
          row.discount === "0.00" &&
          row.chargesEdited === true
        );
      })
    ).toBe(true);
  });
});
