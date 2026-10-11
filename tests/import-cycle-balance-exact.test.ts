/**
 * /api/stats/import-cycle-balance sums every component exactly. Stock of 1.5
 * units at 0.37 is worth 0.555: the raw net balance reads 0.555 and is reported
 * as 0.56 (the float path got 0.5549999… and rounded to 0.55).
 *
 * The endpoint used to write system_settings.equity_adjustment_<company> = -net
 * on every read and then report 0 (a hidden plug). It must now report the
 * difference and write nothing.
 */
import { describe, expect, it, vi } from "vitest";

const writes: string[] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/routes/import-cycle/_helpers", () => ({ _getCached: () => null, _setCached: () => undefined }));
vi.mock("../server/storage", () => ({
  storage: { getAllLedgerAccounts: async () => [], getParentCompanyId: async () => 7 },
}));
// Wave 11: the stock on the floor is the one stock valuation (stockValuation.ts,
// SUM(total_value)), no longer quantity × average_rate from the inventory rows.
// It is mocked at 0.555 (1.5 units worth 0.37 each) to keep exercising the
// single rounding of the exact total.
// Wave 14: suppliers come from the balance engine (none here). Wave 17 A: every
// ledger component is the engine's rows (loadBalanceRows), none here.
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  loadBalanceRows: async () => [],
}));
vi.mock("../server/services/inventory/stockValuation", () => ({ companyStockValue: async () => "0.555" }));
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
  it("reports the exact unreconciled difference and writes no plug", async () => {
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerImportCycleBalanceRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body:
      | {
          netImportCycleBalance: number;
          precisionTrace: { rawNetBalance: number; storedEquityAdjustment: number; discrepancyExplanation: string };
        }
      | undefined;
    const res = {
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handler({ session: { currentCompanyId: 7 } }, res);

    expect(body?.precisionTrace.rawNetBalance).toBe(0.555);
    expect(writes).toEqual([]);
    expect(body?.netImportCycleBalance).toBe(0.56);
    expect(body?.precisionTrace.storedEquityAdjustment).toBe(0);
    expect(body?.precisionTrace.discrepancyExplanation).toBe(
      "Unreconciled difference of 0.56 between ledger and sub-ledger figures. It is not plugged; investigate it with the accounting integrity diagnostic."
    );
  });
});
