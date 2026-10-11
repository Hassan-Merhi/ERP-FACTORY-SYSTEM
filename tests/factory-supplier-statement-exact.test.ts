/**
 * The supplier statement sums container values, payments and balances as exact
 * decimals. 1000 kg × 2.005 + 999.995 freight is exactly 3,004.995, which rounds
 * half up to 3,005.00; as binary floats it was 3,004.99499…, printed as 3,004.99.
 */
import { describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ rows: {} as Record<string, unknown[][]>, calls: {} as Record<string, number> }));

vi.mock("../server/auth", () => ({ requireAuth: (_q: unknown, _s: unknown, next: () => void) => next() }));
vi.mock("../server/routes/factory/suppliers/linkedSupplierGroups", () => ({
  buildLinkedSupplierGroups: async () => [],
}));
vi.mock("../server/db", async () => {
  const { getTableName } = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    db: {
      // Answers each query from the rows registered for its table; repeated
      // queries on one table take the next registered result.
      select: () => {
        let table = "";
        const query: Record<string, unknown> = {};
        query.from = (t: Parameters<typeof getTableName>[0]) => {
          table = getTableName(t);
          return query;
        };
        for (const step of ["where", "orderBy", "innerJoin", "leftJoin", "limit"]) query[step] = () => query;
        query.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) => {
          const call = (harness.calls[table] = (harness.calls[table] ?? 0) + 1);
          const results = harness.rows[table] ?? [[]];
          return Promise.resolve(results[Math.min(call - 1, results.length - 1)]).then(resolve, reject);
        };
        return query;
      },
    },
  };
});

// Wave 13 (owner decision 3): the ledger balance comes from the balance engine
// (raw SQL this harness cannot run); this test pins the operational figures.
vi.mock("../server/routes/factory/suppliers/balance/factorySupplierLedger", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/routes/factory/suppliers/balance/factorySupplierLedger")>();
  return {
    ...actual,
    loadFactorySupplierLedgerViews: async () => new Map(),
    loadFactorySupplierLedgerLines: async () => [],
  };
});

import { registerSupplierStatementRoutes } from "../server/routes/factory/suppliers/supplierStatementRoutes";

describe("factory supplier statement", () => {
  it("totals container values exactly", async () => {
    const container = {
      id: 10,
      supplierId: 1,
      containerNumber: "EXACT-1",
      status: "OFFLOADED",
      arrivalDate: "2026-02-01",
      createdAt: new Date("2026-02-01T00:00:00Z"),
      currencyCode: "USD",
      fxRateToUsd: "1",
      fxRateConfirmed: true,
      totalKg: "1000",
      actualReceivedKg: null,
      ratePerKg: "2.005",
      freight: "999.995",
      freightPaidBy: "supplier",
      freightCurrencyCode: "USD",
      commissionAmount: "0",
    };
    harness.calls = {};
    harness.rows = {
      // the supplier, then the FX-transfer counterparty names
      factory_suppliers: [[{ id: 1, companyId: 7, name: "Exact", parentId: null, openingBalance: "0" }], []],
      // statement containers, broker-commission containers, container-column charges, extra containers
      factory_containers: [[container], [], [], []],
    };
    let body:
      { statement: { value: string }[]; ledger: { amount: string }[]; summary: Record<string, string> } | undefined;
    let handler: ((req: unknown, res: unknown) => Promise<unknown>) | undefined;
    registerSupplierStatementRoutes({
      get: (path: string, ...handlers: never[]) => {
        if (path === "/api/factory/suppliers/:id/statement") handler = handlers.at(-1);
      },
    } as never);
    await handler!(
      { session: { factoryCompanyId: 7 }, params: { id: "1" }, query: {} },
      { status: () => ({ json: () => undefined }), json: (b: typeof body) => (body = b) }
    );

    expect(body?.statement[0].value).toBe("3005.00");
    expect(body?.ledger[0].amount).toBe("+$3,005.00");
    expect(body?.summary.totalValue).toBe("3005.00");
    // summary.netPayable is the ledger balance since wave 13 (no lines here); the container figure is beside it.
    expect(body?.summary.operationalNetPayable).toBe("3005.00");
    expect(body?.summary.netPayable).toBe("0.00");
  });
});
