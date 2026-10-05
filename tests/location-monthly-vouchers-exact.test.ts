/**
 * The location stock-item monthly voucher ledger
 * (/api/locations/:locationId/stock-items/:stockItemId/vouchers/:year/:month)
 * keeps its running balance in exact decimals. With binary floats,
 * 0.1 + 0.2 - 0.3 left 5.55e-17 units in stock, and dividing the remaining
 * value by that residue showed a closing rate in the trillions.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/storage", () => ({
  storage: {
    getStockItemById: async (id: number) => ({ id, name: "Sacks" }),
    getLocationById: async (id: number) => ({ id, name: `Location ${id}` }),
  },
}));
vi.mock("../server/routes/helpers/inventoryHistoryHelpers", () => ({
  calculateHistoricalLocationInventory: async () => [],
}));
vi.mock("../server/db", async () => {
  const { PgDialect } = await import("drizzle-orm/pg-core");
  const dialect = new PgDialect();
  return {
    db: {
      select: (fields: Record<string, unknown>) => {
        let inMonth = false;
        const q: Record<string, unknown> = {};
        for (const step of ["from", "innerJoin", "orderBy"]) q[step] = () => q;
        q.where = (condition: { getSQL: () => never }) => {
          inMonth = dialect.sqlToQuery(condition.getSQL()).sql.includes("EXTRACT");
          return q;
        };
        // Only this month's stock transfers carry rows; every other query is empty.
        q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
          Promise.resolve(inMonth && "sourceLocationId" in fields ? harness.rows.transfers : []).then(resolve, reject);
        return q;
      },
    },
  };
});

import { registerLocationMonthlyVoucherRoutes } from "../server/routes/stock-summary-location/monthly-vouchers";

type Row = { closingQty: number; closingRate: number; closingValue: number };

async function ledger() {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerLocationMonthlyVoucherRoutes({
    get: (_path: string, ...handlers: never[]) => (handler = handlers.at(-1)),
  } as never);
  let body: { transactions: Row[] } | undefined;
  await handler!(
    { params: { locationId: "1", stockItemId: "2", year: "2026", month: "3" }, session: { currentCompanyId: 7 } },
    { status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
  );
  return body!.transactions;
}

const transfer = (day: string, quantity: string, totalAmount: string, inward: boolean) => ({
  voucherDate: `2026-03-${day}`,
  voucherId: Number(day),
  quantity,
  rate: "1.00",
  totalAmount,
  sourceLocationId: inward ? 3 : 1,
  destinationLocationId: inward ? 1 : 3,
});

describe("location monthly voucher ledger", () => {
  it("runs the balance to exactly zero, without a float-residue closing rate", async () => {
    harness.rows.transfers = [
      transfer("01", "0.1", "0.10", true),
      transfer("02", "0.2", "0.20", true),
      transfer("03", "0.3", "0.29", false),
      transfer("04", "1", "5.00", true),
    ];
    const rows = await ledger();

    expect(rows[2]).toMatchObject({ closingQty: 0, closingRate: 0 });
    expect(rows[2].closingValue).toBe(0.01);
    expect(rows[1].closingQty).toBe(0.3);
  });
});
