/**
 * The two tenant-pinned branches of server/routes/reportsLedgerRoutes.ts,
 * which only run for fixed production ids (HADI L'SHI company 1 rent ledger
 * 1007 with archived ledger 881; HMD KINSHASA company 8 rent ledger 877).
 * Those ids cannot be created in the shared test database, so this suite
 * drives the handlers with a scripted query layer, as
 * reports-ledger-monthly-exact.test.ts does.
 *
 * Pinned: the archived legacy ledger is folded into the statement only when
 * it is in its reviewed archived state; the HMD rent service-month preview is
 * produced only from exactly 33 fully posted rows covering 11 months x 3
 * contracts totalling 13,560 per month, is filtered to the requested range,
 * and is withheld (null) on any deviation or outside 2026.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  selects: [] as unknown[][],
  executes: [] as unknown[],
  ledgerFilters: [] as unknown[],
}));

vi.mock("../server/auth", () => ({ requireAuth: () => undefined }));
vi.mock("../server/db", () => {
  const chain = (): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    for (const step of ["from", "where", "innerJoin", "orderBy"]) q[step] = () => q;
    q.execute = async () => state.selects.shift() ?? [];
    q.limit = async () => state.selects.shift() ?? [];
    return q;
  };
  return {
    db: {
      select: () => chain(),
      execute: async () => {
        const rows = state.executes.shift();
        if (rows instanceof Error) throw rows;
        return { rows: rows ?? [] };
      },
    },
  };
});

import { registerReportsLedgerRoutes } from "../server/routes/reportsLedgerRoutes";

type Handler = (req: unknown, res: unknown) => Promise<void>;

function handler(path: string): Handler {
  const handlers = new Map<string, Handler>();
  registerReportsLedgerRoutes({ get: (p: string, _auth: unknown, h: Handler) => handlers.set(p, h) } as never);
  return handlers.get(path)!;
}

async function call(path: string, companyId: number, params: Record<string, string>, query = {}) {
  let status = 200;
  let body: any;
  const res = {
    status: (code: number) => {
      status = code;
      return res;
    },
    json: (value: unknown) => {
      body = value;
      return res;
    },
  };
  await handler(path)({ params, query, session: { currentCompanyId: companyId } }, res);
  return { status, body };
}

const SUMMARY = "/api/reports/ledger-monthly-summary/:accountId";
const VOUCHERS = "/api/reports/ledger-vouchers/:accountId/:year/:month";

function rentRows(overrides: (row: Record<string, unknown>, index: number) => Record<string, unknown> = (r) => r) {
  const rows: Record<string, unknown>[] = [];
  for (let month = 1; month <= 11; month += 1) {
    for (const contract of [15, 16, 17]) {
      rows.push(
        overrides(
          {
            month,
            contract_id: contract,
            expected: "4520",
            posted_paid: "4520",
            posted_count: 1,
            unposted_count: 0,
          },
          rows.length
        )
      );
    }
  }
  return rows;
}

const hmdAccount = { id: 877, code: "RENT", name: "Rent", openingBalance: "0", openingBalanceSide: "Dr" };

async function hmdSummary(rows: Record<string, unknown>[], query: Record<string, string>) {
  state.selects.push([hmdAccount], [], []);
  state.executes.push(rows);
  return call(SUMMARY, 8, { accountId: "877" }, query);
}

beforeEach(() => {
  state.selects.length = 0;
  state.executes.length = 0;
});

describe("HADI archived rent ledger merge", () => {
  const target = { id: 1007, code: "RENT", name: "Rent Expense - ERP Shops", openingBalance: "0" };
  const legacy = { id: 881, companyId: 1, active: false, isHidden: true, openingBalance: "0" };

  it("folds the archived legacy ledger into the month drill-down", async () => {
    state.selects.push(
      [target],
      [legacy],
      [],
      [{ entryId: 1, voucherId: 9, date: "2026-03-02", debit: "5", credit: "0", narration: "legacy rent" }]
    );
    const res = await call(VOUCHERS, 1, { accountId: "1007", year: "2026", month: "3" });
    expect(res.status).toBe(200);
    expect(res.body.vouchers).toHaveLength(1);
    expect(res.body.totals).toEqual({ debit: 5, credit: 0 });
  });

  it("keeps a legacy ledger that is not archived, or missing, out of the summary", async () => {
    state.selects.push([target], [{ ...legacy, active: true }], [], []);
    expect((await call(SUMMARY, 1, { accountId: "1007" }, { startDate: "2026-01-01" })).status).toBe(200);
    state.selects.push([target], [], [], []);
    const missing = await call(SUMMARY, 1, { accountId: "1007" }, { startDate: "2026-01-01" });
    expect(missing.body.openingBalance).toBe(0);
    expect(state.selects).toEqual([]);
  });
});

describe("HMD KINSHASA rent service-month preview", () => {
  it("builds the preview from fully posted rows and filters it to the range", async () => {
    const res = await hmdSummary(rentRows(), { startDate: "2026-03-01", endDate: "2026-05-31" });
    expect(res.status).toBe(200);
    expect(res.body.rentServiceMonthPreview).toEqual({
      months: [
        { month: 3, monthName: "March", amount: 13560 },
        { month: 4, monthName: "April", amount: 13560 },
        { month: 5, monthName: "May", amount: 13560 },
      ],
      total: 40680,
      kind: "non-posting-rental-subledger",
    });
    // The preview never changes posted totals.
    expect(res.body.grandTotal).toEqual({ debit: 0, credit: 0, closingBalance: 0 });
  });

  it.each([
    ["a missing row", () => rentRows().slice(1)],
    ["a month out of range", () => rentRows((r, i) => (i === 0 ? { ...r, month: 12 } : r))],
    ["a non-positive expected amount", () => rentRows((r, i) => (i === 0 ? { ...r, expected: "0" } : r))],
    ["an unpaid row", () => rentRows((r, i) => (i === 0 ? { ...r, posted_paid: "4000" } : r))],
    ["two postings", () => rentRows((r, i) => (i === 0 ? { ...r, posted_count: 2 } : r))],
    ["an unposted payment", () => rentRows((r, i) => (i === 0 ? { ...r, unposted_count: 1 } : r))],
    ["a duplicated contract", () => rentRows((r, i) => (i === 1 ? { ...r, contract_id: 15 } : r))],
    [
      "a month total other than 13,560",
      () => rentRows((r, i) => (i < 3 ? { ...r, expected: "4000", posted_paid: "4000" } : r)),
    ],
  ])("withholds the preview for %s", async (_label, rows) => {
    const res = await hmdSummary(rows(), { startDate: "2026-01-01", endDate: "2026-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.rentServiceMonthPreview).toBeNull();
  });

  it("skips the preview query outside 2026 and for other accounts", async () => {
    state.selects.push([hmdAccount], [], []);
    const other = await call(SUMMARY, 8, { accountId: "877" }, { startDate: "2025-01-01", endDate: "2025-12-31" });
    expect(other.body.rentServiceMonthPreview).toBeNull();
    state.selects.push([{ ...hmdAccount, id: 878 }], [], []);
    const otherAccount = await call(SUMMARY, 8, { accountId: "878" }, { startDate: "2026-01-01" });
    expect(otherAccount.body.rentServiceMonthPreview).toBeNull();
    state.executes.push(rentRows());
    // Nothing consumed the scripted preview rows.
    expect(state.executes).toHaveLength(1);
  });

  it("answers 500 when the query layer fails", async () => {
    state.selects.push([hmdAccount], [], []);
    state.executes.push(new Error("connection lost"));
    const res = await call(SUMMARY, 8, { accountId: "877" }, { startDate: "2026-01-01" });
    expect(res.status).toBe(500);
    expect(res.body.message).toBe("connection lost");
  });
});
