import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const daybookValues: unknown[] = [];
  const tables = {
    vouchers: { id: "vouchers.id" },
    voucherEntries: { id: "entries.id", voucherId: "entries.voucherId" },
    customerBalances: {
      companyId: "balances.companyId",
      referenceId: "balances.referenceId",
      referenceType: "balances.referenceType",
    },
    interCompanyTransfers: { fromVoucherId: "ict.from", toVoucherId: "ict.to" },
    customerOrderCharges: {
      id: "charges.id",
      orderId: "charges.orderId",
      amount: "charges.amount",
      chargeType: "charges.type",
      voucherId: "charges.voucherId",
      ledgerAccountId: "charges.ledgerId",
    },
    customerOrders: {
      id: "orders.id",
      companyId: "orders.companyId",
      customerId: "orders.customerId",
      grandTotal: "orders.grandTotal",
    },
    fSettings: { companyId: "settings.companyId" },
    fde: { referenceTable: "fde.table", referenceId: "fde.ref" },
  };

  const makeSelectBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };

  const db: any = {
    transaction: vi.fn(),
    select: vi.fn(() => makeSelectBuilder(selectResults.shift() ?? [])),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn(async (values: unknown) => {
        daybookValues.push({ table, values });
        return [];
      }),
    })),
  };

  return {
    db,
    selectResults,
    daybookValues,
    tables,
    syncEmployeeBalancesFromEntries: vi.fn(),
    snapshotVoucherEntries: vi.fn(async (entries: unknown[]) => entries),
    buildVoucherChangesForCreate: vi.fn(() => ({ created: true })),
    buildVoucherChangesForUpdate: vi.fn(() => ({ updated: true })),
    logAudit: vi.fn(),
    writeVoucherAuditTx: vi.fn(),
    readVoucherAuditState: vi.fn(async () => ({ voucher: null, entries: [] })),
    checkAccountWhatsAppRule: vi.fn(),
    recalculateOrderTotals: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
  requireNonPOS: (_req: any, _res: any, next: any) => next(),
}));
vi.mock("../server/routes/_helpers", () => ({
  logAudit: harness.logAudit,
  syncEmployeeBalancesFromEntries: harness.syncEmployeeBalancesFromEntries,
  snapshotVoucherEntries: harness.snapshotVoucherEntries,
  buildVoucherChangesForCreate: harness.buildVoucherChangesForCreate,
  buildVoucherChangesForUpdate: harness.buildVoucherChangesForUpdate,
}));
// Wave 12: voucher audit rows are written in the route's transaction by voucherAuditTrail.
vi.mock("../server/routes/helpers/voucherAuditTrail", () => ({
  writeVoucherAuditTx: harness.writeVoucherAuditTx,
  readVoucherAuditState: harness.readVoucherAuditState,
}));
vi.mock("../server/routes/factoryWhatsappRoutes", () => ({
  checkAccountWhatsAppRule: harness.checkAccountWhatsAppRule,
}));
vi.mock("../server/routes/factory/_helpers", () => ({ recalculateOrderTotals: harness.recalculateOrderTotals }));
vi.mock("../server/lib/migratedVoucherGuard", () => ({
  isReadonlyMigratedVoucher: () => false,
  READONLY_MIGRATED_VOUCHER_MESSAGE: "read only",
}));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));
vi.mock("../server/services/accounting/currencyAmounts", () => ({
  normalizeVoucherEntryAmounts: ({
    transactionCurrency,
    transactionDebitAmount,
    transactionCreditAmount,
    historicalRate,
  }: any) => {
    const rate = transactionCurrency === "USD" ? 1 : Number(historicalRate || 1);
    const debit = Number(transactionDebitAmount || 0) / rate;
    const credit = Number(transactionCreditAmount || 0) / rate;
    return {
      debitAmount: debit.toFixed(6),
      creditAmount: credit.toFixed(6),
      transactionCurrency,
      transactionDebitAmount: String(transactionDebitAmount || "0"),
      transactionCreditAmount: String(transactionCreditAmount || "0"),
      baseDebitAmount: debit.toFixed(6),
      baseCreditAmount: credit.toFixed(6),
      historicalExchangeRate: historicalRate ? String(historicalRate) : null,
      rateConvention: "TRANSACTION_PER_BASE",
    };
  },
  erpRateToDaybookFxRateToUsd: (currency: string, _base: string, rate: unknown) =>
    currency === "USD" ? 1 : 1 / Number(rate),
}));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  or: (...conditions: unknown[]) => ({ type: "or", conditions }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
}));
vi.mock("@shared/schema", () => ({
  vouchers: harness.tables.vouchers,
  voucherEntries: harness.tables.voucherEntries,
  customerBalances: harness.tables.customerBalances,
  interCompanyTransfers: harness.tables.interCompanyTransfers,
  customerOrderCharges: harness.tables.customerOrderCharges,
  customerOrders: harness.tables.customerOrders,
  factorySettings: harness.tables.fSettings,
  factoryDaybookEntries: harness.tables.fde,
}));

import { registerVoucherJournalRoutes } from "../server/routes/vouchers/voucherJournalRoutes";

type Handler = (req: any, res: any) => unknown;

function routesHarness() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.set(`${method} ${path}`, handlers.at(-1));
  const app: any = { post: register("POST"), patch: register("PATCH") };
  registerVoucherJournalRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    session: { currentCompanyId: 4, userId: "admin-1", username: "admin" },
    body: {},
    params: {},
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
  };
  return res;
}

describe("journal voucher route behavior", () => {
  const routes = routesHarness();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.daybookValues.splice(0);
    harness.checkAccountWhatsAppRule.mockResolvedValue({ prompt: true, accountId: 1, month: "2026-08" });
  });

  it("rejects missing fields and unbalanced non-optional journals before opening a transaction", async () => {
    const missing = resHarness();
    await routes.get("POST /api/vouchers/journal")!(req({ body: { voucherDate: "2026-08-12" } }), missing);
    expect(missing.statusCode).toBe(400);
    expect(missing.body).toEqual({ message: "Missing required fields" });

    const unbalanced = resHarness();
    await routes.get("POST /api/vouchers/journal")!(
      req({
        body: {
          voucherDate: "2026-08-12",
          entries: [
            { type: "DR", accountType: "ledger", accountId: 1, amount: "100" },
            { type: "CR", accountType: "bank", accountId: 2, amount: "99" },
          ],
        },
      }),
      unbalanced
    );
    expect(unbalanced.statusCode).toBe(400);
    expect(unbalanced.body).toEqual({ message: "Total debits must equal total credits" });
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });

  it("posts a balanced CFA journal in historical USD base while preserving native amounts", async () => {
    const createdVoucher = {
      id: 90,
      companyId: 4,
      voucherNumber: "JOURNAL-90",
      voucherType: "Journal",
      voucherDate: "2026-08-12",
      description: "CFA correction",
      totalAmount: "1.000000",
      optional: false,
      currency: "CFA",
      exchangeRate: "500",
    };
    const createdEntries = [
      {
        id: 1,
        voucherId: 90,
        ledgerAccountId: 1,
        employeeId: null,
        customerId: null,
        debitAmount: "1.000000",
        creditAmount: "0.000000",
      },
      {
        id: 2,
        voucherId: 90,
        bankAccountId: 2,
        ledgerAccountId: null,
        employeeId: null,
        customerId: null,
        debitAmount: "0.000000",
        creditAmount: "1.000000",
      },
    ];
    const voucherValues: unknown[] = [];
    const entryValues: unknown[] = [];
    const tx = {
      insert: vi.fn((table: unknown) => {
        const isVoucher = table === harness.tables.vouchers;
        const builder: any = {
          values: vi.fn((values: unknown) => {
            (isVoucher ? voucherValues : entryValues).push(values);
            return builder;
          }),
          returning: vi.fn(async () => (isVoucher ? [createdVoucher] : createdEntries)),
        };
        return builder;
      }),
    };
    harness.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    harness.selectResults.push([{ id: 1 }]);

    const res = resHarness();
    await routes.get("POST /api/vouchers/journal")!(
      req({
        body: {
          voucherDate: "2026-08-12",
          notes: "CFA correction",
          optional: false,
          currency: "CFA",
          exchangeRate: "500",
          effectiveDate: "2026-08-10",
          entries: [
            { type: "DR", accountType: "ledger", accountId: 1, accountName: "Cash", amount: "500", narration: "Debit" },
            { type: "CR", accountType: "bank", accountId: 2, accountName: "Bank", amount: "500", narration: "Credit" },
          ],
        },
      }),
      res
    );

    expect(voucherValues[0]).toMatchObject({
      companyId: 4,
      voucherType: "Journal",
      voucherDate: "2026-08-12",
      description: "CFA correction",
      totalAmount: "1.000000",
      currency: "CFA",
      exchangeRate: "500",
      effectiveDate: "2026-08-10",
    });
    expect(entryValues[0]).toEqual([
      expect.objectContaining({
        ledgerAccountId: 1,
        debitAmount: "1.000000",
        transactionCurrency: "CFA",
        transactionDebitAmount: "500",
        narration: "Debit",
      }),
      expect.objectContaining({
        bankAccountId: 2,
        creditAmount: "1.000000",
        transactionCreditAmount: "500",
        narration: "Credit",
      }),
    ]);
    // Wave 12: the employee balance sync and the audit row run on the voucher's transaction.
    expect(harness.syncEmployeeBalancesFromEntries).toHaveBeenCalledWith(createdEntries, 4, false, tx);
    expect(harness.daybookValues[0]).toMatchObject({
      values: expect.objectContaining({
        companyId: 4,
        txType: "JOURNAL",
        referenceId: 90,
        currencyCode: "CFA",
        amountCurrency: "500",
        fxRateToUsd: 0.002,
        amountUsd: "1",
      }),
    });
    expect(harness.checkAccountWhatsAppRule).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, accountId: 1, accountType: "ledger", voucherType: "Journal" })
    );
    expect(harness.writeVoucherAuditTx).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: "create",
        voucherId: 90,
        before: null,
        after: { voucher: createdVoucher, entries: createdEntries },
      })
    );
    expect(res.body).toMatchObject({ voucher: createdVoucher, entries: createdEntries, whatsapp: { prompt: true } });
  });

  it("allows deliberately optional unbalanced journals", async () => {
    const tx = {
      insert: vi.fn((table: unknown) => {
        const isVoucher = table === harness.tables.vouchers;
        const builder: any = {
          values: vi.fn(() => builder),
          returning: vi.fn(async () =>
            isVoucher
              ? [
                  {
                    id: 91,
                    optional: true,
                    totalAmount: "100.000000",
                    currency: "USD",
                    voucherDate: "2026-08-12",
                    voucherNumber: "JOURNAL-91",
                  },
                ]
              : []
          ),
        };
        return builder;
      }),
    };
    harness.db.transaction.mockImplementationOnce(async (callback: any) => callback(tx));
    harness.selectResults.push([]);
    const res = resHarness();
    await routes.get("POST /api/vouchers/journal")!(
      req({
        body: {
          voucherDate: "2026-08-12",
          optional: true,
          entries: [{ type: "DR", accountType: "ledger", accountId: 1, amount: "100" }],
        },
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(harness.syncEmployeeBalancesFromEntries).not.toHaveBeenCalled();
  });
});
