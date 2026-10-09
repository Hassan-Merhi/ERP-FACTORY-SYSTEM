/**
 * /api/accounts/ledger/:id/balance sums entries exactly: debits of 0.1 and 0.2
 * on a ledger (one through a linked bank account) read 0.3, where the float
 * path returned 0.30000000000000004.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/storage", () => ({
  storage: {
    getVoucherEntriesByLedger: async () => [{ debitAmount: "0.1", creditAmount: "0" }],
    getVoucherEntriesByBankAccount: async () => [{ debitAmount: "0.2", creditAmount: null }],
  },
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const rows: Record<string, unknown[]> = {
    ledger_accounts: [{ openingBalance: "0", openingBalanceSide: "Dr" }],
    customers: [],
    bank_accounts: [{ id: 5, openingBalance: "0", openingBalanceSide: "Dr" }],
  };
  return { db: { select: () => ({ from: (table: never) => chain(rows[getTableName(table)] ?? []) }) } };
});

import { registerAccountLedgerBalanceRoutes } from "../server/routes/accounts/ledger-balance";

describe("ledger balance", () => {
  it("sums ledger and linked-bank entries exactly", async () => {
    const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
    registerAccountLedgerBalanceRoutes({
      get: (path: string, _auth: unknown, handler: (req: unknown, res: unknown) => Promise<void>) => {
        handlers.set(path, handler);
      },
    } as never);
    let body: { balance?: number } | undefined;
    const res = {
      set: () => res,
      status: () => res,
      json: (value: typeof body) => {
        body = value;
        return res;
      },
    };
    await handlers.get("/api/accounts/ledger/:id/balance")!(
      { params: { id: "9" }, session: { currentCompanyId: 7 } },
      res
    );
    expect(body).toEqual({ balance: 0.3 });
  });
});
