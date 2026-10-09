import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const executeResults: unknown[] = [];
  const returningResults: unknown[][] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      execute: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const insertedValues: unknown[] = [];
  const updatedValues: unknown[] = [];
  const writeBuilder = (store: unknown[]) => (value: unknown) => {
    store.push(value);
    const result = returningResults.shift() ?? [];
    const builder: any = {
      where: vi.fn(() => builder),
      returning: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const db: any = {
    // Wave 16 (B): bank and fixed-asset writes run in one transaction with their audit.
    transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
    insert: vi.fn(() => ({ values: vi.fn(writeBuilder(insertedValues)) })),
    update: vi.fn(() => ({ set: vi.fn(writeBuilder(updatedValues)) })),
    select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
    execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    delete: vi.fn(() => {
      const result = returningResults.shift() ?? [];
      const builder: any = { where: vi.fn(() => builder), returning: vi.fn(async () => result) };
      return builder;
    }),
  };
  return {
    db,
    pool: { query: vi.fn() },
    selectResults,
    executeResults,
    returningResults,
    insertedValues,
    updatedValues,
    storage: {
      getAllBankAccounts: vi.fn(),
      getBankAccountByCode: vi.fn(),
      getAllLedgerAccounts: vi.fn(),
      createBankAccount: vi.fn(),
      getBankAccountById: vi.fn(),
      updateBankAccount: vi.fn(),
      deleteBankAccount: vi.fn(),
      getAllFixedAssets: vi.fn(),
      getFixedAssetByCode: vi.fn(),
      createFixedAsset: vi.fn(),
    },
    bankParse: vi.fn((value: any) => value),
    bankPartialParse: vi.fn((value: any) => value),
    assetParse: vi.fn((value: any) => value),
    logAudit: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db, pool: harness.pool }));
vi.mock("../server/storage", () => ({ storage: harness.storage }));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireNonPOS: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../server/routes/_helpers", () => ({
  upload: { single: () => (_req: any, _res: any, next: any) => next() },
  logAudit: harness.logAudit,
}));
vi.mock("../server/excelHelper", () => ({ readExcel: vi.fn(), sheetToJson: vi.fn() }));
vi.mock("../server/lib/httpHandlers", () => ({
  getErrorMessage: (error: any) => error?.message || String(error),
  errorStatus: (_error: unknown, fallback = 500) => fallback,
}));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  or: (...conditions: unknown[]) => ({ type: "or", conditions }),
  desc: (column: unknown) => ({ type: "desc", column }),
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), {
    raw: (text: string) => ({ raw: text }),
    join: (parts: unknown[]) => ({ parts }),
  }),
  ne: (column: unknown, value: unknown) => ({ type: "ne", column, value }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
}));
vi.mock("@shared/schema", () => ({
  bankAccounts: { id: "bank.id", companyId: "bank.companyId", code: "bank.code" },
  fixedAssets: { id: "assets.id", companyId: "assets.companyId" },
  ledgerAccounts: {
    id: "ledger.id",
    name: "ledger.name",
    code: "ledger.code",
    companyId: "ledger.companyId",
    accountType: "ledger.accountType",
    openingBalance: "ledger.ob",
    openingBalanceSide: "ledger.side",
    openingBalanceCurrency: "ledger.currency",
    openingBalanceHistoricalRate: "ledger.histRate",
    openingBalanceBaseAmount: "ledger.baseAmount",
    deletedAt: "ledger.deletedAt",
  },
  exchangeRates: {
    rate: "rates.rate",
    companyId: "rates.companyId",
    fromCurrency: "rates.from",
    toCurrency: "rates.to",
    effectiveDate: "rates.date",
  },
  insertBankAccountSchema: {
    parse: harness.bankParse,
    partial: () => ({ parse: harness.bankPartialParse }),
  },
  insertFixedAssetSchema: { parse: harness.assetParse },
}));

import { registerBankAssetRoutes } from "../server/routes/bankAssetRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.set(`${method} ${path}`, handlers.at(-1));
  const app: any = { get: register("GET"), post: register("POST"), put: register("PUT"), delete: register("DELETE") };
  registerBankAssetRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 4, userId: "admin-1", username: "admin" },
    params: {},
    body: {},
    ...overrides,
  } as any;
}

function resHarness() {
  const res: any = {
    statusCode: 200,
    body: undefined,
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
    send: vi.fn((body?: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe("bank and fixed-asset route behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.executeResults.splice(0);
    harness.returningResults.splice(0);
    harness.insertedValues.splice(0);
    harness.updatedValues.splice(0);
    harness.bankParse.mockImplementation((value: any) => value);
    harness.bankPartialParse.mockImplementation((value: any) => value);
    harness.assetParse.mockImplementation((value: any) => value);
    harness.pool.query.mockResolvedValue({ rows: [] });
  });

  it("lists bank accounts using only the current company scope", async () => {
    harness.storage.getAllBankAccounts.mockResolvedValue([{ id: 1, companyId: 4, name: "Cash" }]);
    const res = resHarness();
    await routes.get("GET /api/bank-accounts")!(req(), res);
    expect(harness.storage.getAllBankAccounts).toHaveBeenCalledWith(4);
    expect(res.body).toEqual([{ id: 1, companyId: 4, name: "Cash" }]);
  });

  it.each([
    [{ code: "BANK1", openingBalance: "100" }, "Opening balance requires Dr/Cr side"],
    [{ code: "BANK1", openingBalance: "0", openingBalanceSide: "Dr" }, "Dr/Cr side requires opening balance amount"],
  ])("validates opening-balance amount/side pairs before creating a bank account", async (body, message) => {
    harness.storage.getBankAccountByCode.mockResolvedValue(null);
    const res = resHarness();
    await routes.get("POST /api/bank-accounts")!(req({ body }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message });
    expect(harness.db.insert).not.toHaveBeenCalled();
  });

  it("rejects duplicate bank codes and non-cash linked ledgers", async () => {
    harness.storage.getBankAccountByCode.mockResolvedValueOnce({ id: 9 }).mockResolvedValueOnce(null);
    const duplicate = resHarness();
    await routes.get("POST /api/bank-accounts")!(req({ body: { code: "BANK1" } }), duplicate);
    expect(duplicate.body).toEqual({ message: "Bank account code already exists" });

    harness.storage.getAllLedgerAccounts.mockResolvedValue([{ id: 12, accountType: "Expense" }]);
    const linked = resHarness();
    await routes.get("POST /api/bank-accounts")!(req({ body: { code: "BANK2", linkedLedgerId: 12 } }), linked);
    expect(linked.body).toEqual({ message: "Linked ledger must be Bank or Cash type. Found: Expense" });
  });

  it("creates a validated bank account and writes audit evidence in its transaction", async () => {
    harness.storage.getBankAccountByCode.mockResolvedValue(null);
    harness.storage.getAllLedgerAccounts.mockResolvedValue([{ id: 12, accountType: "Cash" }]);
    harness.returningResults.push([
      { id: 5, name: "Main Cash", code: "CASH1", openingBalance: "100", openingBalanceSide: "Dr" },
    ]);
    const res = resHarness();
    await routes.get("POST /api/bank-accounts")!(
      req({
        body: {
          companyId: 999,
          name: "Main Cash",
          code: "CASH1",
          openingBalance: "100",
          openingBalanceSide: "Dr",
          linkedLedgerId: 12,
        },
      }),
      res
    );
    expect(res.statusCode).toBe(201);
    // The active company, never the body's.
    expect(harness.insertedValues[0]).toEqual(expect.objectContaining({ companyId: 4 }));
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, action: "create", recordId: 5 }),
      harness.db
    );
  });

  it("updates and deletes bank accounts in the company, audited in the same transaction", async () => {
    const existing = { id: 5, companyId: 4, name: "Old", code: "CASH1", openingBalance: "0", linkedLedgerId: null };
    harness.selectResults.push([existing]);
    harness.returningResults.push([{ ...existing, name: "New" }]);
    const update = resHarness();
    await routes.get("PUT /api/bank-accounts/:id")!(req({ params: { id: "5" }, body: { name: "New" } }), update);
    expect(update.statusCode).toBe(200);
    expect(harness.updatedValues[0]).toEqual({ name: "New" });
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "update", recordId: 5, changes: { name: { old: "Old", new: "New" } } }),
      harness.db
    );

    harness.selectResults.push([existing]);
    // The row lock, then the line count (none).
    harness.executeResults.push({ rows: [] }, { rows: [{ live: "0", any: "0" }] });
    const del = resHarness();
    await routes.get("DELETE /api/bank-accounts/:id")!(req({ params: { id: "5" } }), del);
    expect(del.statusCode).toBe(204);
    expect(harness.updatedValues[1]).toEqual(expect.objectContaining({ active: false }));
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "delete", recordId: 5 }),
      harness.db
    );
  });

  it("revalues mixed USD/CFA native balances at the latest CFA/USD rate without rewriting historical base", async () => {
    harness.selectResults.push(
      [
        {
          id: 1,
          name: "Cash",
          code: "CASH",
          accountType: "Cash",
          openingBalance: "100",
          openingBalanceSide: "Dr",
          openingBalanceCurrency: "CFA",
          openingBalanceHistoricalRate: "500",
          openingBalanceBaseAmount: "0.2",
        },
      ],
      [{ rate: "500" }]
    );
    harness.pool.query.mockResolvedValue({
      rows: [
        {
          ledger_account_id: "1",
          entry_currency: "USD",
          native_debit: "10",
          native_credit: "0",
          hist_base_debit: "10",
          hist_base_credit: "0",
        },
        {
          ledger_account_id: "1",
          entry_currency: "CFA",
          native_debit: "500",
          native_credit: "0",
          hist_base_debit: "2",
          hist_base_credit: "0",
        },
      ],
    });
    const res = resHarness();
    await routes.get("GET /api/bank-accounts/revaluation")!(req(), res);

    expect(res.body.currentCfaPerUsd).toBe("500.0000000000");
    expect(res.body.accounts[0]).toMatchObject({
      nativeBalancesByCurrency: { CFA: "600.000000", USD: "10.000000" },
      historicalBaseBalance: "12.200000",
      currentTranslatedBaseBalance: "11.200000",
      translationDifference: "-1.000000",
      openingBalanceCurrencyUnresolved: false,
    });
  });

  it("adds historical fixed-asset debit/credit totals to the asset API shape", async () => {
    harness.storage.getAllFixedAssets.mockResolvedValue([{ id: 3, code: "CAR", name: "Vehicle" }]);
    harness.pool.query.mockResolvedValue({ rows: [{ fixed_asset_id: "3", hist_debit: "1000", hist_credit: "250" }] });
    const res = resHarness();
    await routes.get("GET /api/fixed-assets")!(req(), res);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: 3,
        assetCode: "CAR",
        assetName: "Vehicle",
        historicalCostBase: 1000,
        historicalDepreciationBase: 250,
      }),
    ]);
  });

  it("requires useful life for depreciating assets", async () => {
    harness.storage.getFixedAssetByCode.mockResolvedValue(null);
    const res = resHarness();
    await routes.get("POST /api/fixed-assets")!(
      req({ body: { code: "CAR", name: "Vehicle", depreciationMethod: "Straight Line", usefulLife: 0 } }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain("Useful life");
  });

  it("creates a fixed asset in the active company, ignoring a companyId in the body", async () => {
    harness.storage.getFixedAssetByCode.mockResolvedValue(null);
    harness.returningResults.push([{ id: 9, name: "Van" }]);
    const res = resHarness();
    await routes.get("POST /api/fixed-assets")!(
      req({ body: { companyId: 999, code: "VAN", name: "Van", depreciationMethod: "None" } }),
      res
    );
    expect(res.statusCode).toBe(201);
    expect(harness.insertedValues[0]).toEqual(expect.objectContaining({ companyId: 4 }));
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "create", recordId: 9 }),
      harness.db
    );
  });

  it("blocks fixed-asset deletion while voucher entries still reference it", async () => {
    harness.executeResults.push({ rows: [{ cnt: "2" }] });
    const res = resHarness();
    await routes.get("DELETE /api/fixed-assets/:id")!(req({ params: { id: "3" } }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain("2 voucher entry/entries");
    expect(harness.db.delete).not.toHaveBeenCalled();
  });
});
