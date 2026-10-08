/**
 * The closing-stock routes value stock exactly:
 * - 0.1 + 0.2 units at 1.00 report a quantity and value of 0.3 (the float
 *   path returned 0.30000000000000004);
 * - carrying forward 0.5 units holding 1.01 stores an opening value of "1.01"
 *   (wave 11: rows are valued by total_value, never quantity x rate).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  inventory: [] as Array<Record<string, string | number>>,
  updates: [] as Array<Record<string, unknown>>,
  mirror: new Set<number>(),
}));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined, requireRole: () => () => undefined }));
vi.mock("../server/inventoryHelper", () => ({ adjustInventory: async () => undefined }));
// Wave 11: the carry-forward asks whether the company's perpetual-inventory
// cut-over is applied (it is refused then); this company has none.
vi.mock("../server/services/accounting/perpetualInventory/cutoverRefusal", () => ({
  assertNoInventoryCutoverTx: async () => undefined,
  sendInventoryCutoverRefusal: () => false,
}));
vi.mock("../server/services/accounting/perpetualInventory/factoryValuation", () => ({
  factoryBaleMirrorStockItemIds: async () => state.mirror,
}));
vi.mock("../server/storage", () => ({
  storage: {
    getAllStockGroups: async () => [{ id: 1, code: "G1", name: "Group" }],
    getAllStockItems: async () => [{ id: 10, stockGroupId: 1 }],
    getCompanyById: async () => ({ name: "Co" }),
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "limit"]) q[step] = () => q;
    q.execute = async () => value;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const rowsFor = (table: never) => {
    const name = getTableName(table);
    if (name === "inventory") return state.inventory;
    if (name === "stock_items") return [{ id: 10, code: "I10", name: "Item", stockGroupId: 1 }];
    return [];
  };
  const tx = {
    update: () => ({
      set: (values: Record<string, unknown>) => ({
        where: async () => {
          state.updates.push(values);
        },
      }),
    }),
  };
  return {
    db: {
      select: () => ({ from: (table: never) => chain(rowsFor(table)) }),
      transaction: async (fn: (t: typeof tx) => Promise<void>) => fn(tx),
    },
  };
});

import { registerReportsClosingStockRoutes } from "../server/routes/reportsClosingStockRoutes";

type Handler = (req: unknown, res: unknown) => Promise<void>;
const handlers = new Map<string, Handler>();
registerReportsClosingStockRoutes({
  get: (path: string, ...rest: unknown[]) => handlers.set(`GET ${path}`, rest[rest.length - 1] as Handler),
  post: (path: string, ...rest: unknown[]) => handlers.set(`POST ${path}`, rest[rest.length - 1] as Handler),
} as never);

async function call(key: string, req: Record<string, unknown> = {}) {
  let body: Record<string, unknown> = {};
  const res = {
    status: () => res,
    json: (value: typeof body) => {
      body = value;
      return res;
    },
  };
  await handlers.get(key)!({ session: { currentCompanyId: 7 }, params: {}, body: {}, ...req }, res);
  return body;
}

describe("closing stock exact money", () => {
  beforeEach(() => {
    state.updates = [];
    state.mirror = new Set();
  });

  it("values rows by total_value, not quantity x rate; negative stock and bale mirrors add no value", async () => {
    state.inventory = [
      { stockItemId: 10, quantity: "3", averageRate: "0.33", totalValue: "1.00" },
      { stockItemId: 10, quantity: "-1", averageRate: "0.33", totalValue: "-0.33" },
    ];
    const summary = await call("GET /api/reports/closing-stock-summary");
    expect(summary.grandTotal).toEqual({ quantity: 2, rate: 0.5, value: 1 });
    state.mirror = new Set([10]);
    const mirrored = await call("GET /api/reports/closing-stock-summary");
    expect(mirrored.grandTotal).toEqual({ quantity: 2, rate: 0, value: 0 });
  });

  it("sums inventory rows exactly in the summary and item breakdown", async () => {
    state.inventory = [
      { stockItemId: 10, quantity: "0.1", totalValue: "0.1" },
      { stockItemId: 10, quantity: "0.2", totalValue: "0.2" },
    ];
    const summary = await call("GET /api/reports/closing-stock-summary");
    expect(summary.grandTotal).toEqual({ quantity: 0.3, rate: 1, value: 0.3 });
    expect(summary.stockGroups).toEqual([
      { id: 1, code: "G1", name: "Group", closing: { quantity: 0.3, rate: 1, value: 0.3 }, itemCount: 1 },
    ]);

    const detail = await call("GET /api/reports/closing-stock-summary/:stockGroupId/items", {
      params: { stockGroupId: "1" },
    });
    expect(detail.totals).toEqual({ quantity: 0.3, rate: 1, value: 0.3 });
  });

  it("stores the carried-forward opening value from total_value", async () => {
    state.inventory = [{ stockItemId: 10, quantity: "0.5", totalValue: "1.01" }];
    const body = await call("POST /api/reports/carryforward-closing-stock", { body: { asOfDate: "2030-01-01" } });
    expect(state.updates).toContainEqual({ openingQty: "0.500", openingRate: "2.02", openingValue: "1.01" });
    expect(body.totalValue).toBe("1.01");
  });
});
