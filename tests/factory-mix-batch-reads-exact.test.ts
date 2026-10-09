/**
 * The mix-batch list shows costs at six places rounded half up from the
 * stored value: 2.0000025 is 2.000003 (the float rounded it to 2.000002).
 */
import { describe, expect, it, vi } from "vitest";

const results: unknown[][] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const value = results.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "orderBy", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => chain() } };
});

import { registerFactoryMixBatchReadRoutes } from "../server/routes/factory/mix-batches/reads";

describe("factory mix-batch list", () => {
  it("rounds displayed costs and remaining kilograms from the exact values", async () => {
    results.push([{ id: 1, totalWeightKg: "0.3", usedKg: "0.1", totalCost: "2.0000025", costPerKg: "6.6666750" }]);
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerFactoryMixBatchReadRoutes({
      get: (path: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => handlers.set(path, h),
    } as never);
    let body: any;
    const res = {
      set: () => res,
      status: () => res,
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/mix-batches")!({ query: {}, session: { currentCompanyId: 7 } }, res);

    expect(body[0]).toMatchObject({
      remainingKg: "0.200",
      displayTotalCost: "2.000003",
      displayCostPerKg: "6.666675",
    });
  });
});
