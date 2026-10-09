/**
 * calculateHistoricalLocationInventory reverses movements exactly: adding
 * back sales of 0.1 and 0.2 to 0.3 units on hand reports "0.6" units worth
 * "0.6" (the float path reported 0.6000000000000001).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never, distinct: boolean) => {
    const name = getTableName(table);
    if (distinct) return [];
    if (name === "inventory") return [{ stockItemId: 10, quantity: "0.3", averageRate: "1", totalValue: "0.3" }];
    if (name === "sales_items")
      return [
        { stockItemId: 10, quantity: "0.1", costPrice: "1", totalCost: "0.1" },
        { stockItemId: 10, quantity: "0.2", costPrice: "1", totalCost: "0.2" },
      ];
    if (name === "stock_items") return [{ id: 10, code: "I10", name: "Item", uom: "kg", active: true }];
    return [];
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin"]) q[step] = () => q;
    q.execute = async () => value;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    db: {
      select: () => ({ from: (table: never) => chain(rowsFor(table, false)) }),
      selectDistinct: () => ({ from: (table: never) => chain(rowsFor(table, true)) }),
    },
  };
});

import { calculateHistoricalLocationInventory } from "../server/routes/helpers/inventoryHistoryHelpers";

describe("historical location inventory", () => {
  it("adds reversed sales back exactly", async () => {
    const [row] = await calculateHistoricalLocationInventory(3, 7, "2030-01-01");
    expect(row).toMatchObject({ stockItemId: 10, quantity: "0.6", totalValue: "0.6", averageRate: "1" });
  });
});
