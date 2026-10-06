/**
 * /api/stats/import-cycle-balance sums every component exactly. Stock of 1.5
 * units at 0.37 is worth 0.555: the raw net balance reads 0.555 and the stored
 * equity adjustment is -0.56 (the float path got -0.5549999… and stored -0.55).
 */
import { describe, expect, it, vi } from "vitest";

const writes: string[] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/import-cycle/_helpers", () => ({ _getCached: () => null, _setCached: () => undefined }));
vi.mock("../server/storage", () => ({
  storage: { getAllLedgerAccounts: async () => [], getParentCompanyId: async () => 7 },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "innerJoin"]) q[step] = () => q;
    q.execute = () => Promise.resolve(value);
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return {
    pool: { query: async () => ({ rows: [] }) },
    db: {
      // Only the stock on the floor carries a value; every other component is empty.
      select: () => ({
        from: (table: never) =>
          chain(getTableName(table) === "inventory" ? [{ quantity: "1.5", averageRate: "0.37" }] : []),
      }),
      insert: () => ({
        values: (row: { value: string }) => {
          writes.push(row.value);
          return { onConflictDoUpdate: () => ({ catch: () => undefined }) };
        },
      }),
    },
  };
});

import { registerImportCycleBalanceRoutes } from "../server/routes/import-cycle/balance";

describe("import cycle balance", () => {
  it("stores the equity adjustment at the cent of the exact balance", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerImportCycleBalanceRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: { precisionTrace: { rawNetBalance: number; discrepancyExplanation: string } } | undefined;
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 } }, res);

    expect(body?.precisionTrace.rawNetBalance).toBe(0.555);
    expect(writes).toEqual(["-0.56"]);
    expect(body?.precisionTrace.discrepancyExplanation).toBe(
      "An equity adjustment of -0.56 was applied to zero out the balance."
    );
  });
});
