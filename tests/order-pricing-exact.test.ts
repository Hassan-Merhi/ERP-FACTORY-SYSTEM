/**
 * Customer-order pricing writes bale prices exactly: the per-kg repair
 * prices a 0.5 kg bale at 4.35/kg as "2.18". The float product
 * 2.1749999999999998 was written as "2.17".
 */
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>> }));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/factory/_helpers", () => ({ recalculateOrderTotals: async () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "customer_orders":
        return [{ id: 1, proformaIdUsed: 2 }];
      case "customer_proforma_lines":
        return [{ articleCode: "A", pricingMode: "per_kg", pricePerKg: "4.35" }];
      case "customer_order_bales":
        return [{ id: 9, articleCode: "A", weight: "0.5", priceUsed: "0" }];
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
  return {
    db: {
      select: () => ({ from: (table: never) => chain(rowsFor(table)) }),
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => {
            state.updates.push(values);
          },
        }),
      }),
    },
  };
});

import { registerOrderPricingRoutes } from "../server/routes/factory/customer-orders/orderPricingRoutes";

describe("order pricing exact money", () => {
  it("prices per-kg bales exactly in the repair", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerOrderPricingRoutes({
      post: (path: string, ...rest: unknown[]) => handlers.set(path, rest[rest.length - 1] as never),
      patch: () => undefined,
      get: () => undefined,
    } as never);
    let body: Record<string, unknown> = {};
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/repair-perkg-prices")!({ session: { currentCompanyId: 7 } }, res);

    expect(body).toMatchObject({ balesRepaired: 1, changedOrderIds: [1] });
    expect(state.updates).toEqual([{ priceUsed: "2.18" }]);
  });
});
