/**
 * /api/accounts/ledger/:id/balance (accounts/ledger-balance.ts) is the balance
 * engine's ledger closing (wave 17 A): exact (0.1 + 0.2 reads 0.3), this
 * company's vouchers, a sideless opening by type, optional asOf. A bank linked
 * to the ledger is its own engine row and is no longer folded into the ledger
 * (before, its opening and every line naming it were added here, so a line
 * naming both the ledger and the bank counted twice).
 */
import { describe, expect, it, vi } from "vitest";

const { getPartyBalance } = vi.hoisted(() => ({
  getPartyBalance: vi.fn(async () => ({ closing: "0.30", openingSideAssumed: false })),
}));
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({ getPartyBalance }));
vi.mock("../server/db", async () => {
  const { getTableName } = await import("drizzle-orm");
  const chain = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["where", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  const rows: Record<string, unknown[]> = { ledger_accounts: [{ id: 9 }], customers: [] };
  return { db: { select: () => ({ from: (table: never) => chain(rows[getTableName(table)] ?? []) }) } };
});

// Wave 10: a customer-owned ledger is answered by the balance engine; none owns this one.
vi.mock("../server/lib/factoryCustomerLedger", () => ({ getCustomerByLedgerId: async () => null }));

import { registerAccountLedgerBalanceRoutes } from "../server/routes/accounts/ledger-balance";

describe("ledger balance", () => {
  it("is the engine's exact ledger closing, with an optional asOf", async () => {
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
      { params: { id: "9" }, query: { asOf: "2026-09-30" }, session: { currentCompanyId: 7 } },
      res
    );
    expect(body).toEqual({ balance: 0.3, asOf: "2026-09-30", openingSideAssumed: false });
    expect(getPartyBalance).toHaveBeenCalledWith(expect.anything(), {
      companyId: 7,
      kind: "ledger",
      id: 9,
      asOf: "2026-09-30",
    });
  });
});
