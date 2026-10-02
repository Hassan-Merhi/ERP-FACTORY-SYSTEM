import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const executeResults: unknown[] = [];
  const selectResults: unknown[][] = [];

  const execute = vi.fn(async () => executeResults.shift() ?? { rows: [] });
  const select = vi.fn(() => {
    const result = selectResults.shift() ?? [];
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  });

  const tx: any = { execute, select };
  const db: any = {
    execute,
    select,
    transaction: vi.fn(async (callback: (transaction: any) => unknown) => callback(tx)),
  };

  const tables = {
    stockTransferItems: {
      id: "stockTransferItems.id",
      transferId: "stockTransferItems.transferId",
      quantity: "stockTransferItems.quantity",
      rate: "stockTransferItems.rate",
    },
    stockTransferRevisionItems: {
      revisionId: "stockTransferRevisionItems.revisionId",
    },
    stockTransferRevisions: {
      id: "stockTransferRevisions.id",
      status: "stockTransferRevisions.status",
    },
    stockTransferVouchers: {
      id: "stockTransferVouchers.id",
    },
    vouchers: {
      id: "vouchers.id",
    },
    inventory: {
      companyId: "inventory.companyId",
      locationId: "inventory.locationId",
      stockItemId: "inventory.stockItemId",
      averageRate: "inventory.averageRate",
    },
    locations: {
      id: "locations.id",
      companyId: "locations.companyId",
      deletedAt: "locations.deletedAt",
    },
    stockItems: {
      id: "stockItems.id",
      companyId: "stockItems.companyId",
      active: "stockItems.active",
      deletedAt: "stockItems.deletedAt",
    },
  };

  return { db, execute, executeResults, select, selectResults, tables };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("@shared/schema", () => harness.tables);
vi.mock("../server/inventoryHelper", () => ({ adjustInventory: vi.fn() }));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ type: "inArray", column, values }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

import {
  approveImmutableStockTransferRevision,
  rejectImmutableStockTransferRevision,
  resolveTransferIdByVoucher,
} from "../server/services/immutableStockTransferRevisionLifecycle";

function lockedRevision(status: string, companyId = 4) {
  return {
    revision_id: 41,
    transfer_id: 9,
    revision_number: 3,
    status,
    voucher_id: 90,
    destination_location_id: 8,
    inventory_applied: true,
    company_id: companyId,
    voucher_type: "Stock Transfer",
    deleted_at: null,
  };
}

describe("immutable stock transfer revision review lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.executeResults.splice(0);
    harness.selectResults.splice(0);
  });

  it("rejects a pending revision without mutating transfer quantities", async () => {
    harness.executeResults.push({ rows: [lockedRevision("pending")] }, { rows: [] });
    // Revision items are read before the transfer items they leave untouched.
    harness.selectResults.push(
      [],
      [
        { quantity: "2", rate: "3.50" },
        { quantity: "1", rate: "4" },
      ]
    );

    const result = await rejectImmutableStockTransferRevision(4, 41, "reviewer-1", "  incorrect count  ");

    expect(result).toEqual({
      revisionId: 41,
      transferId: 9,
      voucherId: 90,
      revisionNumber: 3,
      transition: "rejected",
      changedItemCount: 0,
      inventoryApplied: true,
      totalAmount: "11.00",
      items: [],
    });
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it("treats repeated rejection as an idempotent no-op", async () => {
    harness.executeResults.push({ rows: [lockedRevision("rejected")] });
    harness.selectResults.push([], [{ quantity: "5", rate: "2" }]);

    await expect(rejectImmutableStockTransferRevision(4, 41, "reviewer-1")).resolves.toMatchObject({
      transition: "no-op",
      changedItemCount: 0,
      totalAmount: "10.00",
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it("treats repeated approval as an idempotent no-op", async () => {
    harness.executeResults.push({ rows: [lockedRevision("approved")] });
    harness.selectResults.push([{ quantity: "3", rate: "7.25" }]);

    await expect(approveImmutableStockTransferRevision(4, 41, "reviewer-1")).resolves.toMatchObject({
      transition: "no-op",
      changedItemCount: 0,
      inventoryApplied: true,
      totalAmount: "21.75",
    });
  });

  it("rejects review attempts outside the active company", async () => {
    harness.executeResults.push({ rows: [lockedRevision("pending", 99)] });

    await expect(approveImmutableStockTransferRevision(4, 41, "reviewer-1")).rejects.toMatchObject({
      message: "Revision belongs to a different company",
      code: "STOCK_TRANSFER_REVISION_SCOPE",
    });
  });

  it("rejects terminal revision statuses that cannot transition again", async () => {
    harness.executeResults.push({ rows: [lockedRevision("cancelled")] });

    await expect(rejectImmutableStockTransferRevision(4, 41, "reviewer-1")).rejects.toMatchObject({
      message: "Revision #3 is cancelled and cannot be rejected",
      code: "STOCK_TRANSFER_REVISION_STATUS",
    });
  });

  it("resolves a transfer only when the voucher lookup returns a scoped live row", async () => {
    harness.executeResults.push({ rows: [{ id: "19" }] }, { rows: [] });

    await expect(resolveTransferIdByVoucher(4, 90)).resolves.toBe(19);
    await expect(resolveTransferIdByVoucher(4, 91)).resolves.toBeNull();
  });

  it("validates identifiers and reviewer identity before opening a transaction", async () => {
    await expect(approveImmutableStockTransferRevision(0, 41, "reviewer-1")).rejects.toThrow(
      "Company ID must be a positive integer"
    );
    await expect(approveImmutableStockTransferRevision(4, 0, "reviewer-1")).rejects.toThrow(
      "Revision ID must be a positive integer"
    );
    await expect(rejectImmutableStockTransferRevision(4, 41, "   ")).rejects.toThrow("Reviewer ID is required");
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });
});
