/**
 * The factory production summary works in exact kilograms: 2.3 kg used of an
 * 8 kg mix is 28.75%, shown as 28.8 (the float quotient showed 28.7).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const rowsFor = (table: never) => {
    switch (getTableName(table)) {
      case "factory_bales":
        return [
          { status: "PENDING_PRESSING", weightKg: "0.1" },
          { status: "IN_STOCK", weightKg: "0.2" },
        ];
      case "factory_mix_batches":
        return [{ totalWeightKg: "8", usedKg: "2.3" }];
      default:
        return [];
    }
  };
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    q.where = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => ({ from: (table: never) => chain(rowsFor(table)) }) } };
});

import { registerBalesReportRoutes } from "../server/routes/factory/bales/balesReportRoutes";

describe("factory production summary", () => {
  it("rounds mix utilisation from the exact quotient", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerBalesReportRoutes({
      get: (path: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => handlers.set(path, h),
    } as never);
    let body: unknown;
    const res = {
      status: () => res,
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/factory/production-summary")!({ session: { currentCompanyId: 7 } }, res);

    expect(body).toEqual({
      totalBales: 2,
      pendingCount: 1,
      finalizedCount: 1,
      pendingWeight: "0.100",
      finalizedWeight: "0.200",
      totalWeight: "0.300",
      mixBatchUtilization: {
        totalWeightKg: "8.000",
        usedKg: "2.300",
        remainingKg: "5.700",
        utilizationPercent: "28.8",
      },
    });
  });
});
