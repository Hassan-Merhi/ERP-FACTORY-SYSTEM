import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  legs: [] as Array<{
    voucherId: number;
    notes: string | null;
    destinationId: number;
    itemSourceId: number | null;
    headerSourceId: number | null;
  }>,
  names: [
    { id: 1, name: "Kiwele Depot" },
    { id: 2, name: "Hadi 2" },
    { id: 3, name: "Kolwezi" },
  ],
}));

vi.mock("@shared/schema", () => ({
  locations: { id: "locations.id", name: "locations.name", companyId: "locations.companyId" },
  vouchers: { id: "vouchers.id", companyId: "vouchers.companyId" },
  stockTransferItems: { transferId: "stockTransferItems.transferId", sourceLocationId: "stockTransferItems.sourceLocationId" },
  stockTransferVouchers: {
    voucherId: "stockTransferVouchers.voucherId",
    destinationLocationId: "stockTransferVouchers.destinationLocationId",
    sourceLocationId: "stockTransferVouchers.sourceLocationId",
    id: "stockTransferVouchers.id",
    notes: "stockTransferVouchers.notes",
  },
}));
vi.mock("drizzle-orm", () => ({
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => args,
  inArray: (column: unknown, ids: unknown[]) => [column, ids],
}));
vi.mock("../server/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(async () => fixture.legs),
          })),
        })),
        where: vi.fn(async () => fixture.names),
      })),
    })),
  },
}));

import { formatStockTransferNarration, withStockTransferNarrations } from "../server/services/inventory/stockTransferNarration";

describe("stock transfer notes and automatic narration", () => {
  beforeEach(() => {
    fixture.legs.length = 0;
  });

  it("formats single and multiple sources without quotation marks", () => {
    expect(formatStockTransferNarration(["Kiwele Depot"], "Hadi 2"))
      .toBe("Stock Transfer from Kiwele Depot to Hadi 2");
    expect(formatStockTransferNarration(["Hadi 2", "Kiwele Depot", "Hadi 2"], "Kolwezi"))
      .toBe("Stock Transfer from Hadi 2, Kiwele Depot to Kolwezi");
  });

  it("shows a manually typed note instead of the generated text in voucher lists", async () => {
    fixture.legs.push(
      { voucherId: 100, notes: "Transfer for October sales", destinationId: 2, itemSourceId: 1, headerSourceId: 1 },
      { voucherId: 101, notes: "   ", destinationId: 2, itemSourceId: 1, headerSourceId: 1 },
    );
    const result = await withStockTransferNarrations(7, [
      { id: 100, voucherType: "Stock Transfer", description: 'Stock Transfer from "Kiwele Depot" to "Hadi 2"' },
      { id: 101, voucherType: "Stock Transfer", description: 'Stock Transfer from "Kiwele Depot" to "Hadi 2"' },
      { id: 102, voucherType: "Journal", description: "Journal untouched" },
    ]);
    expect(result.map((row) => row.description)).toEqual([
      "Transfer for October sales",
      "Stock Transfer from Kiwele Depot to Hadi 2",
      "Journal untouched",
    ]);
  });
});
