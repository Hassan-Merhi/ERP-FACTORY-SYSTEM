/**
 * fetchStockMovements values adjustment lines exactly: producing 3 units at
 * 0.10 is worth 0.3 and consuming 1.1 units at 1.10 is worth 1.21 (the float
 * path reported 0.30000000000000004 and 1.2100000000000002).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) =>
    getTableName(table) === "stock_adjustment_items"
      ? [
          { date: "2026-01-02", voucherNumber: "ADJ-1", voucherId: 1, qty: "3", rate: "0.10" },
          { date: "2026-01-03", voucherNumber: "ADJ-2", voucherId: 2, qty: "-1.1", rate: "1.10" },
        ]
      : [];
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) } };
});

import { fetchStockMovements } from "../server/routes/inventory-movement/_helpers";

describe("stock movement values", () => {
  it("multiplies adjustment quantity and rate exactly", async () => {
    const rows = await fetchStockMovements(7, 10, null, null, null);
    expect(rows.map((r) => [r.inwardValue, r.outwardQty, r.outwardValue])).toEqual([
      [0.3, 0, 0],
      [0, 1.1, 1.21],
    ]);
  });
});
