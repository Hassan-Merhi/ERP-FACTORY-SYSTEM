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

  it("advances equal-date/equal-voucher rows by entry id and carries the signed chunk opening net", async () => {
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
      .mockResolvedValueOnce({ rows: [{ total: 3, debitTotal: "10", creditTotal: "4" }] });

    const firstReq = {
      params: { id: "55" },
      query: { continuous: "1", limit: "2", endDate: "2026-09-10" },
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
      chunkOpeningNet: 0,
      periodDebitTotal: 10,
      periodCreditTotal: 4,
      closingNetBalance: 6,
    });
    expect(firstPayload.nextCursor).toEqual(expect.any(String));
    expect(String(harness.poolQuery.mock.calls[0][0])).not.toContain(" OFFSET ");

    harness.poolQuery
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ rows: [{ total: 3, debitTotal: "10", creditTotal: "4" }] });

    const secondReq = {
      ...firstReq,
      query: { ...firstReq.query, cursor: firstPayload.nextCursor },
    };
    const secondRes = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    secondRes.status.mockReturnValue(secondRes);

    await harness.handlers.get("/api/accounts/bank/:id/transactions")!(secondReq, secondRes, vi.fn());

    const secondSql = String(harness.poolQuery.mock.calls[2][0]);
    const secondValues = harness.poolQuery.mock.calls[2][1];
    expect(secondSql).toContain("sort_id =");
    expect(secondSql).toContain("sort_entry_id >");
    expect(secondSql).not.toContain(" OFFSET ");
    expect(secondValues).toEqual(expect.arrayContaining(["2026-09-10", 7, 102]));
    expect(secondRes.json).toHaveBeenCalledWith(
      expect.objectContaining({
        continuous: true,
        hasMore: false,
        nextCursor: null,
        chunkOpeningNet: 7,
        preNetBalance: 7,
      })
    );
  });
});
