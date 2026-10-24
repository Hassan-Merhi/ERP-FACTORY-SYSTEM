import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  selectResults: [] as unknown[][],
  poolQuery: vi.fn(),
  normalizeOpeningBalanceCurrency: vi.fn(),
  getCashBankAccountSummary: vi.fn(),
  getCashBankRevaluation: vi.fn(),
  getCashLedgerAccountSummary: vi.fn(),
  schema: {
    companies: { id: "companies.id", baseCurrency: "companies.baseCurrency" },
    ledgerAccounts: {
      id: "ledgerAccounts.id",
      companyId: "ledgerAccounts.companyId",
      deletedAt: "ledgerAccounts.deletedAt",
    },
    bankAccounts: { id: "bankAccounts.id", companyId: "bankAccounts.companyId" },
  },
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireNonPOS: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@shared/schema", () => harness.schema);
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
}));
vi.mock("../server/services/accounting/openingBalanceCurrency", () => ({
  normalizeOpeningBalanceCurrency: harness.normalizeOpeningBalanceCurrency,
}));
vi.mock("../server/services/accounting/cashBankRevaluationService", () => ({
  getCashBankAccountSummary: harness.getCashBankAccountSummary,
  getCashBankRevaluation: harness.getCashBankRevaluation,
}));
vi.mock("../server/services/accounting/cashLedgerAccountSummaryService", () => ({
  getCashLedgerAccountSummary: harness.getCashLedgerAccountSummary,
}));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  errorStatus: () => 500,
}));
vi.mock("../server/db", () => ({
  db: {
    select: vi.fn(() => {
      const result = harness.selectResults.shift() ?? [];
      const builder: any = {
        from: vi.fn(() => builder),
        where: vi.fn(() => builder),
        limit: vi.fn(async () => result),
        then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject),
      };
      return builder;
    }),
  },
  pool: { query: harness.poolQuery },
}));

import { normalizeAccountOpeningBalance, registerAccountCurrencyRoutes } from "../server/routes/accountCurrencyRoutes";

function resHarness() {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe("account currency and historical opening behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.selectResults.splice(0);
    harness.getCashBankAccountSummary.mockReset();
    harness.getCashBankRevaluation.mockReset();
    harness.getCashLedgerAccountSummary.mockReset();
    harness.normalizeOpeningBalanceCurrency.mockReset();
    registerAccountCurrencyRoutes({
      get: (path: string, ...callbacks: any[]) => harness.handlers.set(path, callbacks.at(-1)!),
      // The Zambia USD/ZMW cash conversion route registers alongside the reads.
      post: (path: string, ...callbacks: any[]) => harness.handlers.set(path, callbacks.at(-1)!),
    } as never);
  });

  it("keeps a non-zero legacy opening explicitly unresolved when currency is not supplied", async () => {
    harness.selectResults.push([{ baseCurrency: "USD" }]);
    const req: any = {
      method: "POST",
      path: "/api/ledger-accounts",
      session: { currentCompanyId: 4 },
      body: { openingBalance: "125.50", openingBalanceSide: "Dr" },
    };
    const res = resHarness();
    const next = vi.fn();

    await normalizeAccountOpeningBalance(req, res as any, next);

    expect(next).toHaveBeenCalledOnce();
    expect(req.body).toMatchObject({
      openingBalance: "125.5",
      openingBalanceNativeAmount: null,
      openingBalanceCurrency: null,
      openingBalanceHistoricalRate: null,
      openingBalanceBaseAmount: null,
    });
    expect(harness.normalizeOpeningBalanceCurrency).not.toHaveBeenCalled();
  });

  it("normalizes an explicit foreign-currency opening into locked historical base metadata", async () => {
    harness.selectResults.push([{ baseCurrency: "USD" }]);
    harness.normalizeOpeningBalanceCurrency.mockReturnValue({
      openingBalanceNativeAmount: "100",
      openingBalanceCurrency: "EUR",
      openingBalanceHistoricalRate: "1.2",
      openingBalanceBaseAmount: "120",
    });
    const req: any = {
      method: "POST",
      path: "/api/bank-accounts",
      session: { currentCompanyId: 4 },
      body: {
        openingBalance: "100",
        openingBalanceCurrency: "EUR",
        openingBalanceHistoricalRate: "1.2",
      },
    };
    const res = resHarness();
    const next = vi.fn();

    await normalizeAccountOpeningBalance(req, res as any, next);

    expect(harness.normalizeOpeningBalanceCurrency).toHaveBeenCalledWith(
      expect.objectContaining({
        openingBalance: "100",
        openingBalanceCurrency: "EUR",
        openingBalanceHistoricalRate: "1.2",
        baseCurrency: "USD",
      })
    );
    expect(req.body).toMatchObject({
      openingBalance: "120",
      openingBalanceNativeAmount: "100",
      openingBalanceCurrency: "EUR",
      openingBalanceBaseAmount: "120",
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("preserves resolved historical metadata when an old edit form resubmits the unchanged base amount", async () => {
    harness.selectResults.push(
      [{ baseCurrency: "USD" }],
      [
        {
          id: 7,
          companyId: 4,
          openingBalance: "120",
          openingBalanceNativeAmount: "100",
          openingBalanceCurrency: "EUR",
          openingBalanceHistoricalRate: "1.2",
          openingBalanceBaseAmount: "120",
        },
      ]
    );
    const req: any = {
      method: "PATCH",
      path: "/api/ledger-accounts/7",
      session: { currentCompanyId: 4 },
      body: { openingBalance: "120", accountName: "Cash" },
    };
    const res = resHarness();
    const next = vi.fn();

    await normalizeAccountOpeningBalance(req, res as any, next);

    expect(req.body).toMatchObject({
      openingBalance: "120",
      openingBalanceNativeAmount: "100",
      openingBalanceCurrency: "EUR",
      openingBalanceHistoricalRate: "1.2",
      openingBalanceBaseAmount: "120",
    });
    expect(next).toHaveBeenCalledOnce();
  });

  it("marks a changed legacy amount unresolved instead of pretending it retained the old currency conversion", async () => {
    harness.selectResults.push(
      [{ baseCurrency: "USD" }],
      [
        {
          id: 7,
          companyId: 4,
          openingBalance: "120",
          openingBalanceNativeAmount: "100",
          openingBalanceCurrency: "EUR",
          openingBalanceHistoricalRate: "1.2",
          openingBalanceBaseAmount: "120",
        },
      ]
    );
    const req: any = {
      method: "PATCH",
      path: "/api/ledger-accounts/7",
      session: { currentCompanyId: 4 },
      body: { openingBalance: "130" },
    };
    const res = resHarness();
    const next = vi.fn();

    await normalizeAccountOpeningBalance(req, res as any, next);
    expect(req.body).toMatchObject({
      openingBalance: "130",
      openingBalanceNativeAmount: null,
      openingBalanceCurrency: null,
      openingBalanceHistoricalRate: null,
      openingBalanceBaseAmount: null,
    });
  });

  it("does not allow account editing through another company scope", async () => {
    harness.selectResults.push([{ baseCurrency: "USD" }], []);
    const req: any = {
      method: "PATCH",
      path: "/api/ledger-accounts/77",
      session: { currentCompanyId: 4 },
      body: { openingBalance: "10" },
    };
    const res = resHarness();
    await normalizeAccountOpeningBalance(req, res as any, vi.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ message: "Account not found" });
  });

  it("adds unresolved opening and legacy raw net to a translated cash balance", async () => {
    harness.getCashLedgerAccountSummary.mockResolvedValueOnce({
      currentTranslatedBaseBalance: "100.5",
      historicalBaseBalance: "90",
      openingBalanceCurrencyUnresolved: true,
      unresolvedOpeningBalanceRaw: "20",
      unresolvedLegacyNetRaw: "4.5",
      nativeBalancesByCurrency: { USD: "100.5" },
      totalsProvisional: true,
    });
    const res = resHarness();
    await harness.handlers.get("/api/accounts/ledger/:id/balance")!(
      { session: { currentCompanyId: 4 }, params: { id: "7" } },
      res
    );
    expect(harness.getCashLedgerAccountSummary).toHaveBeenCalledWith(4, 7);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ balance: 125, totalsProvisional: true }));
  });

  it("falls back to historical ledger accounting and flags unresolved legacy values as provisional", async () => {
    harness.getCashLedgerAccountSummary.mockResolvedValueOnce(null);
    harness.selectResults.push([
      {
        id: 7,
        companyId: 4,
        openingBalance: "30",
        openingBalanceSide: "Cr",
        openingBalanceBaseAmount: null,
        openingBalanceNativeAmount: null,
        openingBalanceCurrency: null,
      },
    ]);
    harness.poolQuery.mockResolvedValue({
      rows: [{ historical_net: "80", unresolved_count: "2", unresolved_raw_net: "5" }],
    });
    const res = resHarness();

    await harness.handlers.get("/api/accounts/ledger/:id/balance")!(
      { session: { currentCompanyId: 4 }, params: { id: "7" } },
      res
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        balance: 55,
        historicalBaseBalance: "80.000000",
        unresolvedOpeningBalanceRaw: "-30.000000",
        unresolvedLegacyNetRaw: "5.000000",
        totalsProvisional: true,
      })
    );
    expect(harness.poolQuery).toHaveBeenCalledWith(expect.stringContaining("v.company_id = $2"), [7, 4]);
  });

  it("returns native debit/credit buckets without losing historical translation evidence", async () => {
    harness.getCashBankAccountSummary.mockResolvedValueOnce({
      nativeBalancesByCurrency: { USD: "120", EUR: "-35" },
      historicalBaseBalance: "90",
      currentTranslatedBaseBalance: "95",
      translationDifference: "5",
      totalsProvisional: false,
    });
    const res = resHarness();
    await harness.handlers.get("/api/accounts/ledger/:id/currency-balances")!(
      { session: { currentCompanyId: 4 }, params: { id: "7" } },
      res
    );
    expect(res.json).toHaveBeenCalledWith([
      {
        currency: "USD",
        totalDebit: 120,
        totalCredit: 0,
        net: 120,
        historicalBaseBalance: "90",
        currentTranslatedBaseBalance: "95",
        translationDifference: "5",
        totalsProvisional: false,
      },
      {
        currency: "EUR",
        totalDebit: 0,
        totalCredit: 35,
        net: -35,
        historicalBaseBalance: "90",
        currentTranslatedBaseBalance: "95",
        translationDifference: "5",
        totalsProvisional: false,
      },
    ]);
  });

  it("returns company-scoped cash/bank revaluation and rejects unscoped requests", async () => {
    harness.getCashBankRevaluation.mockResolvedValue({
      totalHistorical: "100",
      totalCurrent: "110",
    });
    const res = resHarness();
    await harness.handlers.get("/api/bank-accounts/revaluation")!({ session: { currentCompanyId: 4 } }, res);
    expect(harness.getCashBankRevaluation).toHaveBeenCalledWith(4);
    expect(res.json).toHaveBeenCalledWith({ totalHistorical: "100", totalCurrent: "110" });

    const noCompany = resHarness();
    await harness.handlers.get("/api/bank-accounts/revaluation")!({ session: {} }, noCompany);
    expect(noCompany.status).toHaveBeenCalledWith(400);
  });
});
