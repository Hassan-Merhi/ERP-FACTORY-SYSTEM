import { describe, expect, it, vi } from "vitest";
import type { DbTransaction } from "../server/db";
import {
  assertNoLinkedSupplierReturnsTx,
  OffloadLinkedSupplierReturnError,
} from "../server/services/containers/offload-lifecycle/assertNoLinkedSupplierReturnsTx";

function fakeTx(tableName: string | null, batchIds: number[]) {
  const execute = vi
    .fn()
    // The source-item lock is always taken first, even when return tables are absent.
    .mockResolvedValueOnce({ rows: [] })
    .mockResolvedValueOnce({ rows: [{ tableName }] });
  if (tableName) execute.mockResolvedValueOnce({ rows: batchIds.map((batchId) => ({ batchId })) });
  return { execute } as unknown as DbTransaction & { execute: typeof execute };
}

describe("ERP offload linked supplier-return guard", () => {
  it("permits reversal when the controlled return migration is not installed", async () => {
    const tx = fakeTx(null, []);
    await expect(assertNoLinkedSupplierReturnsTx(tx, 25, 615)).resolves.toBeUndefined();
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("permits reversal when there are no linked supplier returns", async () => {
    const tx = fakeTx("erp_supplier_return_lines", []);
    await expect(assertNoLinkedSupplierReturnsTx(tx, 25, 615)).resolves.toBeUndefined();
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  it("rejects linked returns with a clear 409 and source batch numbers", async () => {
    const tx = fakeTx("erp_supplier_return_lines", [101, 102]);
    await expect(assertNoLinkedSupplierReturnsTx(tx, 25, 615)).rejects.toMatchObject({
      name: "OffloadLinkedSupplierReturnError",
      code: "OFFLOAD_HAS_SUPPLIER_RETURNS",
      status: 409,
      message: expect.stringContaining("#101, #102"),
    });
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  it("does not expose raw database errors in the user-facing conflict type", () => {
    const error = new OffloadLinkedSupplierReturnError([7]);
    expect(error.message).toContain("Supplier Returns history");
    expect(error.message).not.toContain("DELETE FROM");
  });
});
