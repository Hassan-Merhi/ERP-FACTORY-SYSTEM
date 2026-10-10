/**
 * Bale costs are priced exactly: 1.7 kg at 0.1234565/kg is 0.20987605, kept as
 * 0.2098761 by numeric(20, 7). The float product 0.20987604999999998 was kept
 * as 0.2098760.
 *
 * Wave 11: the bale cost backfill (POST /api/factory/bales/backfill-costs)
 * re-costed every in-stock bale from its mix sources at the containers'
 * native-currency cost, automatically and unaudited. It is retired (410):
 * bales are re-costed only through the reviewed preview → Owner confirm →
 * apply. This test used to pin the backfill's arithmetic; it now pins the
 * same exactness on the shared bale cost (baleCostFromMix, used by pressing,
 * stock entry, assign-bales and the reviewed re-cost) and the retirement.
 */
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ writes: 0 }));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const write = () => {
    state.writes += 1;
    throw new Error("the retired backfill must not write");
  };
  return { db: { select: write, update: write, transaction: write } };
});

import { registerBalesFinalizeRoutes } from "../server/routes/factory/bales/balesFinalizeRoutes";
import { baleCostFromMix } from "../server/services/factory/baleCostBasis";

/** What a numeric(20, 7) column keeps of a written value. */
const stored = (value: unknown) => new Decimal(String(value)).toDecimalPlaces(7, Decimal.ROUND_HALF_UP).toFixed(7);

describe("bale cost", () => {
  it("prices a bale from its mix exactly", () => {
    const cost = baleCostFromMix("1.700", "0.1234565");
    expect(stored(cost.costPerKg)).toBe("0.1234565");
    expect(stored(cost.totalCost)).toBe("0.2098761");
  });

  it("no longer backfills bale costs automatically", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerBalesFinalizeRoutes({
      post: (path: string, ...rest: unknown[]) => handlers.set(path, rest[rest.length - 1] as never),
      get: () => undefined,
      patch: () => undefined,
    } as never);
    let statusCode = 200;
    let body: Record<string, unknown> = {};
    const res = {
      status: (code: number) => {
        statusCode = code;
        return res;
      },
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/bales/backfill-costs")!({ session: { currentCompanyId: 7 } }, res);

    expect(statusCode).toBe(410);
    expect(body).toMatchObject({ code: "FACTORY_BALE_RECOST_MOVED" });
    expect(state.writes).toBe(0);
  });
});
