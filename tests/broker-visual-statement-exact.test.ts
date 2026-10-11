/**
 * The broker visual statement values containers and totals per currency
 * exactly: 1.3 kg at 0.35 is 0.455 of goods (the float product was
 * 0.45499999999999996), and payments of 0.10 and 0.20 are 0.30 paid.
 */
import { describe, expect, it, vi } from "vitest";

const results: unknown[][] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const value = results.shift() ?? [];
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy", "$dynamic"]) q[step] = () => q;
    q.then = (resolve: (v: unknown) => unknown, reject: (r: unknown) => unknown) =>
      Promise.resolve(value).then(resolve, reject);
    return q;
  };
  return { db: { select: () => chain() } };
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

import { registerSupplierBrokerVisualStatementRoutes } from "../server/routes/factory/suppliers/broker/visual-statement";

describe("broker visual statement", () => {
  it("values goods and per-currency totals exactly", async () => {
    results.push(
      [{ id: 3, name: "Broker" }],
      [],
      [
        {
          id: 1,
          supplierId: 3,
          containerNumber: "C-1",
          actualReceivedKg: "1.3",
          ratePerKg: "0.35",
          currencyCode: "USD",
        },
      ],
      [
        { id: 1, supplierId: 3, amount: "0.10", currencyCode: "USD", amountUsd: "0.10", date: "2026-09-01" },
        { id: 2, supplierId: 3, amount: "0.20", currencyCode: "USD", amountUsd: "0.20", date: "2026-09-02" },
      ],
      [],
      []
    );
    let handler: (req: unknown, res: unknown) => Promise<void> = async () => undefined;
    registerSupplierBrokerVisualStatementRoutes({
      get: (_path: string, _auth: unknown, h: typeof handler) => {
        handler = h;
      },
    } as never);
    let body: any;
    const res = {
      status: () => res,
      json: (value: unknown) => {
        body = value;
        return res;
      },
    };
    await handler({ params: { id: "3" }, query: {}, session: { currentCompanyId: 7 } }, res);

    expect(body.containers[0].goodsAmount).toBe(0.455);
    expect(body.creditByCurrency).toEqual({ USD: 0.455 });
    expect(body.paidByCurrency).toEqual({ USD: 0.3 });
  });
});
