/**
 * recalculateOrderTotals writes order lines and totals at their columns'
 * scales from exact sums. Bale prices of 100.01 and 324.28 average 212.145,
 * stored as 212.15; the float path wrote 212.14499999999998, which Postgres
 * stored as 212.14.
 */
import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";

vi.mock("../server/db", () => ({ db: {} }));

import { recalculateOrderTotals } from "../server/routes/factory/_helpers";

describe("customer order totals", () => {
  it("writes exact line averages and totals", async () => {
    const tables: Record<string, unknown[]> = {
      customer_order_bales: [
        { articleCode: "A", baleName: "A", weight: "100.001", priceUsed: "100.01" },
        { articleCode: "A", baleName: "A", weight: "349.048", priceUsed: "324.28" },
      ],
      customer_orders: [{ proformaIdUsed: null }],
      customer_order_charges: [
        { chargeType: "FREIGHT", amount: "0.10" },
        { chargeType: "OTHER", amount: "0.20" },
      ],
    };
    const writes: Array<[string, Record<string, unknown>]> = [];
    const chain = (value: unknown) => {
      const q: Record<string, unknown> = { where: () => q };
      q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
        Promise.resolve(value).then(resolve, reject);
      return q;
    };
    const tx = {
      select: () => ({ from: (table: never) => chain(tables[getTableName(table)] ?? []) }),
      delete: () => ({ where: async () => undefined }),
      insert: (table: never) => ({
        values: async (row: Record<string, unknown>) => void writes.push([getTableName(table), row]),
      }),
      update: (table: never) => ({
        set: (row: Record<string, unknown>) => ({
          where: async () => void writes.push([getTableName(table), row]),
        }),
      }),
    };

    await recalculateOrderTotals(tx as never, 77);

    expect(writes[0]).toEqual([
      "customer_order_lines",
      expect.objectContaining({
        qty: 2,
        weightPerBale: "224.525",
        totalWeight: "449.049",
        pricePerBale: "212.15",
        totalPrice: "424.29",
      }),
    ]);
    expect(writes[1]).toEqual([
      "customer_orders",
      expect.objectContaining({
        subtotalBales: "424.29",
        freightAmount: "0.10",
        otherChargesTotal: "0.20",
        grandTotal: "424.59",
      }),
    ]);
  });
});
