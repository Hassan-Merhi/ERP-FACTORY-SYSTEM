/**
 * The location monthly detail values lines exactly: a credit note of 1.3
 * units at 0.35 is worth 0.455 (the float product was
 * 0.45499999999999996), and a sale of 3 units costed at 0.1 is 0.3.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "credit_note_items":
        return [{ date: "2026-09-02", ref: "CN-1", qty: "1.3", inventoryCost: "0.35", noteType: "Credit Note" }];
      case "sales_items":
        return [
          {
            date: "2026-09-03",
            ref: "S-1",
            qty: "3",
            costPrice: "0.1",
            totalCost: null,
            sellingPrice: "1",
            totalSales: null,
          },
        ];
      default:
        return [];
    }
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) } };
});

import { registerLocationMonthlyDetailRoutes } from "../server/routes/stock-summary-location/monthly-detail";

describe("location monthly detail", () => {
  it("values credit-note and sale lines exactly", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerLocationMonthlyDetailRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: { inTransactions: Array<Record<string, unknown>>; outTransactions: Array<Record<string, unknown>> } = {
      inTransactions: [],
      outTransactions: [],
    };
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler(
      {
        params: { locationId: "1", stockItemId: "2" },
        query: { year: "2026", month: "9" },
        session: { currentCompanyId: 7 },
      },
      res
    );

    expect(body.inTransactions).toEqual([expect.objectContaining({ type: "Credit Note", qty: 1.3, value: 0.455 })]);
    expect(body.outTransactions).toEqual([expect.objectContaining({ type: "Sale", qty: 3, value: 0.3, rate: 0.1 })]);
  });
});
