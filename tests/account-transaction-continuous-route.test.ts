import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  poolQuery: vi.fn(),
}));

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [{ companyId: 4 }],
        }),
      }),
    }),
  },
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: () => "2026-09-10" }));
vi.mock("../server/routes/helpers/supplierBalanceHelpers", () => ({ authorizeCompanyIdParam: async (_req: unknown, id: number) => id }));
vi.mock("../server/lib/factoryCustomerLedger", () => ({ getCustomerByLedgerId: async () => null }));
vi.mock("../server/services/accounting/accountStatementCurrency", () => ({ summarizeAccountStatementCurrency: () => [] }));
vi.mock("@shared/schema", () => ({
  bankAccounts: { id: "bank.id", companyId: "bank.companyId" },
  companies: { id: "companies.id", companyType: "companies.companyType" },
  customers: { id: "customers.id", companyId: "customers.companyId" },
  employees: { id: "employees.id", companyId: "employees.companyId" },
  fixedAssets: { id: "fixedAssets.id", companyId: "fixedAssets.companyId" },
  ledgerAccounts: { id: "ledger.id", companyId: "ledger.companyId", deletedAt: "ledger.deletedAt" },
}));
vi.mock("@shared/schema/supplierCompanyScope", () => ({
  companyScopedSuppliers: { id: "suppliers.id", companyId: "suppliers.companyId", deletedAt: "suppliers.deletedAt" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ isNull: column }),
}));

import { registerAccountTransactionPaginationRoutes } from "../server/routes/accountTransactionPaginationRoutes";

const previousNodeEnv = process.env.NODE_ENV;
const previousSecret = process.env.CONTINUOUS_CURSOR_SECRET;

describe("account transaction continuous chunks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    process.env.NODE_ENV = "test";
    process.env.CONTINUOUS_CURSOR_SECRET = "account-wave-two-secret-1234";
    registerAccountTransactionPaginationRoutes({
      get: (path: string, ...callbacks: Array<(...args: unknown[]) => unknown>) => {
        harness.handlers.set(path, callbacks.at(-1)!);
      },
    } as never);
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.CONTINUOUS_CURSOR_SECRET;
    else process.env.CONTINUOUS_CURSOR_SECRET = previousSecret;
  });

  it("advances equal-date rows and reuses signed first-chunk aggregates on later chunks", async () => {
    harness.poolQuery
      .mockResolvedValueOnce({
        rows: [
          {
            entryId: 101,
            voucherId: 7,
            debitAmount: "10",
            creditAmount: "0",
            voucherDate: "2026-09-10",
            sort_date: "2026-09-10",
            sort_id: 7,
            sort_entry_id: 101,
          },
          {
            entryId: 102,
            voucherId: 7,
            debitAmount: "0",
            creditAmount: "3",
            voucherDate: "2026-09-10",
            sort_date: "2026-09-10",
            sort_id: 7,
            sort_entry_id: 102,
          },
          {
            entryId: 103,
            voucherId: 7,
            debitAmount: "0",
            creditAmount: "1",
            voucherDate: "2026-09-10",
            sort_date: "2026-09-10",
            sort_id: 7,
            sort_entry_id: 103,
          },
        ],
      })
      .mockResolvedValueOnce({ rows: [{ total: 3, debitTotal: "10", creditTotal: "4" }] })
      .mockResolvedValueOnce({ rows: [{ net: "25" }] });

    const firstReq = {
      params: { id: "55" },
      query: {
        continuous: "1",
        limit: "2",
        startDate: "2026-09-01",
        endDate: "2026-09-10",
      },
      session: { currentCompanyId: 4 },
    };
    const firstRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    firstRes.status.mockReturnValue(firstRes);

    await harness.handlers.get("/api/accounts/bank/:id/transactions")!(firstReq, firstRes, vi.fn());

    const firstPayload = firstRes.json.mock.calls[0][0];
    expect(firstPayload).toMatchObject({
      continuous: true,
      total: 3,
      limit: 2,
      hasMore: true,
      chunkOpeningNet: 25,
      periodPreNetBalance: 25,
      periodDebitTotal: 10,
      periodCreditTotal: 4,
      closingNetBalance: 31,
    });
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    expect(harness.poolQuery).toHaveBeenCalledTimes(3);
    expect(String(harness.poolQuery.mock.calls[0][0])).not.toContain(" OFFSET ");
    expect(String(harness.poolQuery.mock.calls[1][0])).toContain("COUNT(*)::int AS total");
    expect(String(harness.poolQuery.mock.calls[2][0])).toContain("< $3::date");

    harness.poolQuery.mockResolvedValueOnce({
      rows: [
        {
          entryId: 103,
          voucherId: 7,
          debitAmount: "0",
          creditAmount: "1",
          voucherDate: "2026-09-10",
          sort_date: "2026-09-10",
          sort_id: 7,
          sort_entry_id: 103,
        },
      ],
    });

    const secondReq = {
      ...firstReq,
      query: { ...firstReq.query, cursor: firstPayload.nextCursor },
    };
    const secondRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    secondRes.status.mockReturnValue(secondRes);

    await harness.handlers.get("/api/accounts/bank/:id/transactions")!(secondReq, secondRes, vi.fn());

    expect(harness.poolQuery).toHaveBeenCalledTimes(4);
    const secondSql = String(harness.poolQuery.mock.calls[3][0]);
    const secondValues = harness.poolQuery.mock.calls[3][1];
    expect(secondSql).toContain("sort_id =");
    expect(secondSql).toContain("sort_entry_id >");
    expect(secondSql).not.toContain(" OFFSET ");
    expect(secondSql).not.toContain("COUNT(*)::int AS total");
    expect(secondValues).toEqual(expect.arrayContaining(["2026-09-10", 7, 102]));
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        continuous: true,
        total: 3,
        periodDebitTotal: 10,
        periodCreditTotal: 4,
        closingNetBalance: 31,
        hasMore: false,
        nextCursor: null,
        chunkOpeningNet: 32,
        preNetBalance: 32,
      })
    );
  });
});
