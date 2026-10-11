/**
 * The supplier detail balance (/api/factory/suppliers/:id/balance) is summed as
 * exact decimals, so it agrees with the list card to the cent instead of
 * carrying binary-float residue (0.1 + 0.2 = 0.30000000000000004).
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ queue: [] as unknown[] }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => {
  const query = (value: unknown) => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy", "limit"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => query(harness.queue.shift() ?? []) } };
});

// Wave 13 (owner decision 3): `balance` is the ledger's (balance engine); the
// container formula this test pins is returned as `operationalMemo`.
vi.mock("../server/routes/factory/suppliers/balance/factorySupplierLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/routes/factory/suppliers/balance/factorySupplierLedger")>();
  return { ...actual, loadFactorySupplierLedgerViews: async () => new Map() };
});

import { registerSupplierBalanceSingleRoutes } from "../server/routes/factory/suppliers/balance/single";

function balanceHandler() {
  let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
  registerSupplierBalanceSingleRoutes({
    get: (path: string, ...handlers: never[]) => {
      if (path === "/api/factory/suppliers/:id/balance") handler = handlers.at(-1);
    },
  } as never);
  return handler!;
}

describe("factory supplier single balance", () => {
  it("returns the exact balance, without float residue", async () => {
    const supplier = { id: 5, companyId: 7, name: "Exact", parentId: null, openingBalance: "0" };
    const payments = ["0.1", "0.2"].map((amountUsd, i) => ({ id: i + 1, supplierId: 5, amountUsd }));
    // suppliers, containers, payments, voucher payments, FX transfers, post-offload charges
    harness.queue = [[supplier], [], payments, [], [], []];
    let body: { balance: number; outstandingUsd: number; operationalMemo: { outstandingUsd: string } } | undefined;
    await balanceHandler()(
      { session: { factoryCompanyId: 7 }, params: { id: "5" } },
      { set: () => undefined, status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
    );

    expect(body?.operationalMemo.outstandingUsd).toBe("-0.30");
    // No ledger lines in this harness: the ledger balance is zero.
    expect(body?.balance).toBe(0);
  });
});
