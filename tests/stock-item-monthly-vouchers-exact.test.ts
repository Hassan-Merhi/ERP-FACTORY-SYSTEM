/**
 * The company-wide stock-item monthly ledger
 * (/api/stock-items/:id/vouchers/:year/:month) keeps its running balance in
 * exact decimals: receiving 0.1 + 0.2 units and selling 0.3 now closes at
 * exactly 0 @ 0, where binary floats left 5.55e-17 units with a closing rate
 * of 8 computed from the residues.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ purchases: [] as unknown[], sales: [] as unknown[] }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/routes/stock-summary-location", () => ({ registerStockSummaryLocationRoutes: () => undefined }));
vi.mock("../server/storage", () => ({
  storage: {
    getStockItemById: async (id: number) => ({ id, name: "Sacks" }),
    getLocationById: async (id: number) => ({ id, name: `Location ${id}` }),
  },
}));
vi.mock("../server/db", () => ({
  db: {
    select: (fields: Record<string, unknown>) => {
      // This month's purchase lines and sales carry rows; every other query is empty.
      const rows = "poNumber" in fields ? harness.purchases : "sellingPrice" in fields ? harness.sales : [];
      const q: Record<string, unknown> = {};
      for (const step of ["from", "innerJoin", "where", "orderBy"]) q[step] = () => q;
      q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject);
      return q;
    },
  },
}));

import { registerStockSummaryRoutes } from "../server/routes/stockSummaryRoutes";

type Row = { closingQty: number; closingRate: number; closingValue: number };

async function ledger() {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerStockSummaryRoutes({
    get: (path: string, ...handlers: never[]) => {
      if (path === "/api/stock-items/:id/vouchers/:year/:month") handler = handlers.at(-1);
    },
  } as never);
  let body: { transactions: Row[]; totals: Row } | undefined;
  await handler!(
    { params: { id: "2", year: "2026", month: "3" }, session: { currentCompanyId: 7 } },
    { status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
  );
  return body!;
}

const purchase = (day: string, quantity: string, lineTotal: string) => ({
  date: new Date(`2026-03-${day}T10:00:00Z`),
  poId: 9,
  poNumber: "PO-9",
  containerNumber: "C-1",
  quantity,
  rate: "10.00",
  lineTotal,
});

describe("stock item monthly ledger", () => {
  it("closes exactly at zero once everything received is sold", async () => {
    harness.purchases = [purchase("01", "0.1", "1.00"), purchase("02", "0.2", "2.00")];
    harness.sales = [
      {
        voucherDate: "2026-03-03",
        voucherNumber: "S-1",
        voucherId: 4,
        locationId: null,
        locationName: "Shop",
        quantity: "0.3",
        sellingPrice: "12.00",
        totalSales: "3.60",
        costPrice: "10.00",
        totalCost: "3.00",
        optional: false,
      },
    ];
    const { transactions, totals } = await ledger();

    expect(transactions.at(-1)).toMatchObject({ closingQty: 0, closingRate: 0, closingValue: 0 });
    expect(totals).toMatchObject({ closingQty: 0, closingRate: 0, closingValue: 0 });
  });
});
