/**
 * The ledger monthly summary and voucher drill-down sum exactly: credits of
 * 0.10 and 0.20 in a month are 0.30 (the float sum was 0.30000000000000004),
 * and the opening balance keeps its credit-positive sign.
 *
 * Phase 27 (RP-9): the opening is the engine's and the movements are the
 * engine's owned lines (ledgerMonthlySummary.ts), mocked here; the database
 * behaviour is covered by tests/phase27-reporting.test.ts. Before, this test
 * mocked the route's own drizzle queries, which are gone.
 */
import { describe, expect, it, vi } from "vitest";
import { toMoney } from "../server/lib/money";

const results: unknown[][] = [];
const lineRows: unknown[] = [];
vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy"]) q[step] = () => q;
    q.execute = async () => results.shift() ?? [];
    return q;
  };
  return { db: { select: () => chain(), execute: async () => ({ rows: lineRows.splice(0) }) } };
});
const engine = vi.hoisted(() => ({ opening: "0", movements: new Map<string, unknown>() }));
vi.mock("../server/services/accounting/companyBusinessDate", () => ({ companyBusinessDate: async () => "2026-10-11" }));
vi.mock("../server/services/accounting/reporting/ledgerMonthlySummary", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../server/services/accounting/reporting/ledgerMonthlySummary")>();
  return {
    ...original,
    ledgerOwnership: async (_companyId: number, accountId: number) => ({ kind: "ledger", id: accountId, lines: {} }),
    engineOpeningAt: async () => toMoney(engine.opening),
    monthlyMovements: async () => engine.movements,
  };
});

import { registerReportsLedgerRoutes } from "../server/routes/reportsLedgerRoutes";

function routes() {
  const handlers = new Map<string, (req: unknown, res: unknown) => Promise<void>>();
  registerReportsLedgerRoutes({
    get: (path: string, _auth: unknown, h: (req: unknown, res: unknown) => Promise<void>) => handlers.set(path, h),
  } as never);
  return handlers;
}

async function call(path: string, params: Record<string, string>, query: Record<string, string> = {}) {
  let body: any;
  const res = {
    status: () => res,
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };
  await routes().get(path)!({ params, query, session: { currentCompanyId: 7 } }, res);
  return body;
}

describe("ledger reports", () => {
  it("sums the monthly summary exactly", async () => {
    results.push([{ id: 5, code: "L1", name: "Ledger", openingBalance: "1.10", openingBalanceSide: "Dr" }]);
    // The engine's debit-positive balance before the start: Dr 1.10 opening, Cr 0.20 earlier.
    engine.opening = "0.90";
    engine.movements = new Map([["2026-03", { yearMonth: "2026-03", debit: toMoney(0), credit: toMoney("0.30") }]]);
    const body = await call(
      "/api/reports/ledger-monthly-summary/:accountId",
      { accountId: "5" },
      { startDate: "2026-01-01", endDate: "2026-12-31" }
    );

    expect(body.openingBalance).toBe(-0.9);
    expect(body.months[2]).toMatchObject({ yearMonth: "2026-03", credit: 0.3, closingBalance: -0.6 });
    expect(body.grandTotal).toEqual({ debit: 0, credit: 0.3, closingBalance: -0.6 });
  });

  it("sums the month's vouchers exactly", async () => {
    results.push([{ id: 5, code: "L1", name: "Ledger", openingBalance: "0", openingBalanceSide: "Cr" }]);
    engine.opening = "0";
    lineRows.push(
      { entry_id: 1, voucher_id: 1, booked_on: "2026-03-05", debit: "0", credit: "0.10", narration: "a" },
      { entry_id: 2, voucher_id: 2, booked_on: "2026-03-06", debit: "0", credit: "0.20", narration: "b" }
    );
    const body = await call("/api/reports/ledger-vouchers/:accountId/:year/:month", {
      accountId: "5",
      year: "2026",
      month: "3",
    });

    expect(body.totals).toEqual({ debit: 0, credit: 0.3 });
    expect(body.closingBalance).toBe(0.3);
  });
});
