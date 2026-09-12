import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("../../db", () => ({
  pool: {
    query: mocks.query,
  },
}));

import { getVoucherEntriesBySupplierBatched } from "./supplierVoucherEntryBatcher";

describe("supplier voucher-entry batcher", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it("loads concurrent supplier balances for one company in one SQL query", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          __supplierId: 11,
          entryId: 1,
          voucherId: 101,
          debitAmount: "0",
          creditAmount: "25",
          companyId: 7,
        },
        {
          __supplierId: 12,
          entryId: 2,
          voucherId: 102,
          debitAmount: "5",
          creditAmount: "0",
          companyId: 7,
        },
      ],
    });

    const [supplier11, supplier12] = await Promise.all([
      getVoucherEntriesBySupplierBatched(11, 7),
      getVoucherEntriesBySupplierBatched(12, 7),
    ]);

    expect(mocks.query).toHaveBeenCalledOnce();
    expect(mocks.query.mock.calls[0][1]).toEqual([[11, 12], 7]);
    expect(supplier11).toEqual([expect.objectContaining({ entryId: 1, creditAmount: "25", companyId: 7 })]);
    expect(supplier12).toEqual([expect.objectContaining({ entryId: 2, debitAmount: "5", companyId: 7 })]);
    expect(supplier11[0]).not.toHaveProperty("__supplierId");
  });

  it("keeps batches isolated by company", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });

    await Promise.all([
      getVoucherEntriesBySupplierBatched(11, 7),
      getVoucherEntriesBySupplierBatched(11, 8),
    ]);

    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(mocks.query.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        [[11], 7],
        [[11], 8],
      ])
    );
  });
});
