/**
 * The location monthly summary keeps quantities and values exact. Receiving
 * 0.1 + 0.2 units (worth 1.1 + 2.2) and selling 0.3 (cost 3.3) leaves nothing
 * on hand; the float path kept 5.55e-17 units worth 4.4e-16 and reported
 * March's opening rate as 8.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/storage", () => ({
  storage: { getStockItemById: async () => ({ id: 2 }), getLocationById: async () => ({ id: 3 }) },
}));
vi.mock("../server/routes/_helpers", () => ({ calculateHistoricalLocationInventory: async () => [] }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit", "innerJoin", "leftJoin"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const rows: Record<string, unknown[]> = {
    stock_transfer_items: [
      { month: 1, quantity: "0.1", totalAmount: "1.1", sourceLocationId: 9, destinationLocationId: 3 },
      { month: 1, quantity: "0.2", totalAmount: "2.2", sourceLocationId: 9, destinationLocationId: 3 },
    ],
    sales_items: [{ month: 2, quantity: "0.3", totalCost: "3.3" }],
  };
  return {
    db: { select: () => ({ from: (table: never) => chain(rows[getTableName(table)] ?? []) }) },
  };
});

import { registerLocationMonthlySummaryRoutes } from "../server/routes/stock-summary-location/monthly-summary";

describe("location monthly summary", () => {
  it("closes an emptied stock at zero quantity, value and rate", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerLocationMonthlySummaryRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: { monthlyData: Array<Record<string, number>> } | undefined;
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler(
      { params: { locationId: "3", stockItemId: "2" }, query: { year: "2024" }, session: { currentCompanyId: 7 } },
      res
    );
    const march = body!.monthlyData[2];
    expect(march).toMatchObject({ openingQty: 0, openingValue: 0, openingRate: 0 });
  });
});
