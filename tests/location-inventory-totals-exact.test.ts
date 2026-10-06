/**
 * The factory location inventory (/api/factory/location-inventory/:locationId)
 * totals each product's bales exactly: two bales of 0.1 kg and 0.2 kg weigh
 * 0.3 kg, not the binary-float 0.30000000000000004.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ rows: {} as Record<string, unknown[]> }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin", "leftJoin", "orderBy"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: (table: never) => chain(harness.rows[getTableName(table)] ?? []) }) } };
});

import { registerFactoryLocationInventoryRoutes } from "../server/routes/factory/stock/locationInventoryRoutes";

describe("factory location inventory", () => {
  it("totals bale weight and cost exactly", async () => {
    const bale = (id: number, weightKg: string) => ({ id, productId: 1, weightKg, quantity: "1", locationId: 1 });
    harness.rows = {
      factory_bales: [bale(1, "0.1"), bale(2, "0.2")],
      factory_bale_products: [{ id: 1, name: "Sacks", articleCode: "S-1", productionPrice: "0.1", sellingPrice: "1" }],
    };
    let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
    registerFactoryLocationInventoryRoutes({
      get: (path: string, ...handlers: never[]) => {
        if (path === "/api/factory/location-inventory/:locationId") handler = handlers.at(-1);
      },
    } as never);
    let body: { totalWeight: number; totalCost: number; quantity: number }[] = [];
    await handler!(
      { params: { locationId: "1" }, session: { factoryCompanyId: 7 } },
      { status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
    );

    expect(body).toHaveLength(1);
    expect(body[0]).toMatchObject({ quantity: 2, totalWeight: 0.3, totalCost: 0.2 });
  });
});
