import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("../../db", () => ({
  pool: { query: mocks.query },
}));

import { getItemMarketBulkSalePrices } from "./itemMarketBulkSalePrices";

describe("Item Market Analysis bulk sale-price export", () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  const filters = {
    companyId: 7,
    stockItemIds: [12, 14, 19],
    locationIds: [32, 33],
    startDate: "2026-01-01",
    endDate: "2026-02-01",
  };

  it("avoids a query when there are no items or authorized locations", async () => {
    expect(await getItemMarketBulkSalePrices({ ...filters, stockItemIds: [] })).toEqual([]);
    expect(await getItemMarketBulkSalePrices({ ...filters, locationIds: [] })).toEqual([]);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("aggregates sale prices and credit-note returns in one scoped query", async () => {
    mocks.query.mockResolvedValue({
      rows: [
        {
          stock_item_id: "12", activity_type: "sale", unit_price: "80.50",
          quantity: "5", revenue: "402.5", profit: "32.25", transaction_count: 2,
        },
        {
          stock_item_id: "12", activity_type: "return", unit_price: "80.50",
          quantity: "-1", revenue: "-80.5", profit: "-6.45", transaction_count: 1,
        },
      ],
    });

    const result = await getItemMarketBulkSalePrices(filters);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    const [sql, params] = mocks.query.mock.calls[0];
    expect(params).toEqual([7, [12, 14, 19], [32, 33], "2026-01-01", "2026-02-01"]);
    expect(sql).toContain("v.company_id = $1 AND si.company_id = $1");
    expect(sql).toContain("s.stock_item_id = ANY($2::int[])");
    expect(sql).toContain("cni.stock_item_id = ANY($2::int[])");
    expect(sql).toContain("v.location_id = ANY($3::int[])");
    expect(sql).toContain("cni.location_id = ANY($3::int[])");
    expect(sql).toContain("v.deleted_at IS NULL");
    expect(sql).toContain("v.voucher_date <= $5::date");
    expect(result).toEqual([
      {
        companyId: 7, stockItemId: 12, activityType: "sale", unitPrice: 80.5,
        quantity: 5, revenue: 402.5, profit: 32.25, transactionCount: 2,
      },
      {
        companyId: 7, stockItemId: 12, activityType: "return", unitPrice: 80.5,
        quantity: -1, revenue: -80.5, profit: -6.45, transactionCount: 1,
      },
    ]);
  });
});
