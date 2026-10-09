/**
 * The bale cost backfill prices bales exactly: 1.7 kg at 0.1234565/kg is
 * 0.20987605, kept as 0.2098761 by numeric(20, 7). The float product
 * 0.20987604999999998 was kept as 0.2098760.
 */
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ updates: [] as Array<Record<string, unknown>> }));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "factory_bales":
        return [{ id: 9, weightKg: "1.700", mixBatchId: 4, articleCode: "A1" }];
      case "factory_mix_batch_sources":
        return [{ mixBatchId: 4, weightKg: "10.000", costPerKg: "0.1234565", containerId: null }];
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

import { registerBalesFinalizeRoutes } from "../server/routes/factory/bales/balesFinalizeRoutes";

/** What a numeric(20, 7) column keeps of a written value. */
const stored = (value: unknown) => new Decimal(String(value)).toDecimalPlaces(7, Decimal.ROUND_HALF_UP).toFixed(7);

describe("bale cost backfill", () => {
  it("prices bales from their mix sources exactly", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerBalesFinalizeRoutes({
      post: (path: string, ...rest: unknown[]) => handlers.set(path, rest[rest.length - 1] as never),
      get: () => undefined,
      patch: () => undefined,
    } as never);
    let body: Record<string, unknown> = {};
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/bales/backfill-costs")!({ session: { currentCompanyId: 7 } }, res);

    expect(body).toMatchObject({ updated: 1 });
    expect(stored(state.updates[0].costPerKg)).toBe("0.1234565");
    expect(stored(state.updates[0].totalCost)).toBe("0.2098761");
  });
});
