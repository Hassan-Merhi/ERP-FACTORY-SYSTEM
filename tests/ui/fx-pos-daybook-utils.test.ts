import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ put: vi.fn(), get: vi.fn() }));

vi.mock("../../client/src/lib/db", () => ({
  db: { bulkFxCache: { put: harness.put, get: harness.get } },
}));

import { cacheBulkFxData, computeBulkFxPreview, getCachedBulkFxData } from "../../client/src/lib/bulkFxOffline";
import { ALL_LOCATIONS_ID, formatQty } from "../../client/src/pages/pos/pospricelist/utils";
import { txCurrencyLabel } from "../../client/src/pages/daybook/voucherdetailsdialog/utils";

const suppliers = [
  { id: 1, name: "Old Supplier", available: 60, oldestDate: "2026-01-01", newestDate: "2026-07-01" },
  { id: 2, name: "New Supplier", available: 80, oldestDate: "2026-03-01", newestDate: "2026-08-01" },
  { id: 3, name: "No Balance", available: 0, oldestDate: null, newestDate: null },
];

describe("offline FX, POS, and Daybook presentation helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(Date, "now").mockReturnValue(1_723_366_800_000);
  });

  it("caches a broker/currency snapshot and expires it after ten minutes", async () => {
    harness.put.mockResolvedValue(undefined);
    await cacheBulkFxData(7, "EUR", suppliers);
    expect(harness.put).toHaveBeenCalledWith({
      brokerId: 7,
      currency: "EUR",
      suppliers,
      cachedAt: 1_723_366_800_000,
    });

    harness.get.mockResolvedValueOnce({ brokerId: 7, currency: "EUR", suppliers, cachedAt: 1_723_366_799_000 });
    await expect(getCachedBulkFxData(7, "EUR")).resolves.toMatchObject({ suppliers });
    harness.get.mockResolvedValueOnce({ brokerId: 7, currency: "EUR", suppliers, cachedAt: 1_723_366_100_000 });
    await expect(getCachedBulkFxData(7, "EUR")).resolves.toBeNull();
    harness.get.mockResolvedValueOnce(undefined);
    await expect(getCachedBulkFxData(7, "EUR")).resolves.toBeNull();
  });

  it("allocates an offline bulk FX preview by oldest or newest exposure without exceeding availability", () => {
    expect(computeBulkFxPreview(suppliers, 100, 1.25, "oldest")).toEqual({
      dryRun: true,
      offline: true,
      totalRequested: "100.0000",
      totalAllocated: "100.0000",
      remaining: "0.0000",
      totalUsd: "125.0000",
      transfers: [
        { supplierId: 1, supplierName: "Old Supplier", allocated: "60.0000", toAmountUsd: "75.0000" },
        { supplierId: 2, supplierName: "New Supplier", allocated: "40.0000", toAmountUsd: "50.0000" },
      ],
    });
    expect(computeBulkFxPreview(suppliers, 20, 1.25, "newest")?.transfers[0].supplierId).toBe(2);
    expect(computeBulkFxPreview([], 20, 1.25, "oldest")).toBeNull();
    expect(computeBulkFxPreview(suppliers, 0, 1.25, "oldest")).toBeNull();
  });

  it("formats price-list quantities, and original transaction currency consistently", () => {
    expect(ALL_LOCATIONS_ID).toBe(-1);
    expect(formatQty(null)).toBe("—");
    expect(formatQty("0")).toBe("—");
    expect(formatQty("1200")).toBe("1,200");
    expect(formatQty("12.3456")).toBe("12.346");
    expect(txCurrencyLabel({ transactionCurrency: "USD" } as never)).toBeNull();
    expect(txCurrencyLabel({ transactionCurrency: "CFA", transactionDebitAmount: "1250" } as never)).toBe("CFA 1,250");
    expect(txCurrencyLabel({ transactionCurrency: "EUR", transactionCreditAmount: "1250.5" } as never)).toBe(
      "EUR 1,250.50"
    );
  });
});
