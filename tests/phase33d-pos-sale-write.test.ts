import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const dbSelectResults: unknown[][] = [];
  const txSelectResults: unknown[][] = [];
  const returningResults: unknown[][] = [];
  const inserted: Array<{ table: unknown; values: any }> = [];
  const updated: Array<{ table: unknown; values: any }> = [];
  const deleted: Array<{ table: unknown }> = [];

  const selectBuilder = (result: unknown[], lockTerminal = false) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      for: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };

  const mutationBuilder = (kind: "update" | "delete", table: unknown) => {
    const builder: any = {
      set: vi.fn((values: any) => {
        if (kind === "update") updated.push({ table, values });
        return builder;
      }),
      where: vi.fn(() => builder),
      returning: vi.fn(async () => returningResults.shift() ?? []),
      then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(undefined).then(resolve, reject),
    };
    if (kind === "delete") deleted.push({ table });
    return builder;
  };

  const tx: any = {
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: any) => {
        inserted.push({ table, values });
        const result = returningResults.shift();
        const builder: any = {
          returning: vi.fn(async () => result ?? []),
          then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
            Promise.resolve(undefined).then(resolve, reject),
        };
        if (result !== undefined) returningResults.unshift(result);
        return builder;
      }),
    })),
    select: vi.fn(() => selectBuilder(txSelectResults.shift() ?? [], true)),
    update: vi.fn((table: unknown) => mutationBuilder("update", table)),
    delete: vi.fn((table: unknown) => mutationBuilder("delete", table)),
  };

  const db: any = {
    select: vi.fn(() => selectBuilder(dbSelectResults.shift() ?? [])),
    transaction: vi.fn(async (callback: (tx: any) => unknown) => callback(tx)),
  };

  return {
    dbSelectResults,
    txSelectResults,
    returningResults,
    inserted,
    updated,
    deleted,
    db,
    tx,
    getOrCreateLedgerAccount: vi.fn(async () => 900),
    withDurableFinancialOperation: vi.fn(async (_options: unknown, callback: (tx: any) => unknown) => callback(tx)),
    resolveFinancialOperationKey: vi.fn(() => "phase33d-key"),
    financialOperationFingerprint: vi.fn(() => "fingerprint"),
    financialOperationRequestPayload: vi.fn((body: unknown) => body),
    loggerError: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/routes/factory/_helpers", () => ({ getOrCreateLedgerAccount: harness.getOrCreateLedgerAccount }));
vi.mock("../server/services/accounting/durableFinancialOperation", () => ({
  financialOperationFingerprint: harness.financialOperationFingerprint,
  withDurableFinancialOperation: harness.withDurableFinancialOperation,
}));
vi.mock("../server/services/accounting/financialOperationRequest", () => ({
  financialOperationRequestPayload: harness.financialOperationRequestPayload,
  resolveFinancialOperationKey: harness.resolveFinancialOperationKey,
}));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: () => "2026-09-17" }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: harness.loggerError } }));

import { registerPosSaleWriteRoutes } from "../server/routes/factory/employee-pos/pos-financial/sale-write";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: Handler[]) =>
      routes.set(`${method} ${path}`, handlers.at(-1)!);
  const app: any = { post: register("POST"), put: register("PUT") };
  registerPosSaleWriteRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    method: "POST",
    path: "/api/factory/pos/sale",
    session: { factoryCompanyId: 7, currentCompanyId: 8, userId: "55", username: "tester" },
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
  };
  return res;
}

describe("Phase 33D factory POS sale writes", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.dbSelectResults.splice(0);
    harness.txSelectResults.splice(0);
    harness.returningResults.splice(0);
    harness.inserted.splice(0);
    harness.updated.splice(0);
    harness.deleted.splice(0);
    harness.getOrCreateLedgerAccount.mockResolvedValue(900);
    harness.resolveFinancialOperationKey.mockReturnValue("phase33d-key");
    harness.financialOperationFingerprint.mockReturnValue("fingerprint");
  });

  it("rejects requests without a selected company or sale lines before any financial write", async () => {
    const noCompany = resHarness();
    await routes.get("POST /api/factory/pos/sale")!(req({ session: {}, body: { items: [{ productName: "Bale", quantity: 1 }] } }), noCompany);
    expect(noCompany.statusCode).toBe(400);
    expect(noCompany.body).toEqual({ message: "No company selected" });

    const noItems = resHarness();
    await routes.get("POST /api/factory/pos/sale")!(req({ body: { items: [] } }), noItems);
    expect(noItems.statusCode).toBe(400);
    expect(noItems.body).toEqual({ message: "At least one item is required" });
    expect(harness.withDurableFinancialOperation).not.toHaveBeenCalled();
  });

  it("rejects lines without a product and non-positive quantities", async () => {
    const noProduct = resHarness();
    await routes.get("POST /api/factory/pos/sale")!(req({ body: { items: [{ quantity: 1, unitPrice: 10 }] } }), noProduct);
    expect(noProduct.statusCode).toBe(400);
    expect(noProduct.body).toEqual({ message: "Each item needs a product" });

    const badQty = resHarness();
    await routes.get("POST /api/factory/pos/sale")!(
      req({ body: { items: [{ productName: "Bale", quantity: 0, unitPrice: 10 }] } }),
      badQty
    );
    expect(badQty.statusCode).toBe(400);
    expect(badQty.body).toEqual({ message: "Quantity must be positive" });
  });

  it("creates a cash sale, nets expenses into cash, and balances the receipt voucher", async () => {
    harness.dbSelectResults.push([{ count: 0 }]);
    harness.returningResults.push([{ id: 101, saleNumber: "FPOS-0001" }], [{ id: 501 }]);
    const res = resHarness();

    await routes.get("POST /api/factory/pos/sale")!(
      req({
        body: {
          locationId: null,
          customerName: "Walk In",
          currencyCode: "USD",
          cashAccountId: 12,
          paymentType: "CASH",
          items: [{ productName: "Loose Bale", quantity: 2, unitPrice: "10" }],
          expenses: [{ accountId: 30, description: "Loading", amount: "2" }, { accountId: 31, amount: "0" }],
        },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ id: 101, saleNumber: "FPOS-0001" });
    expect(harness.withDurableFinancialOperation).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 7, operationName: "factory.pos-sale.create", idempotencyKey: "phase33d-key" }),
      expect.any(Function)
    );

    expect(harness.inserted[0].values).toMatchObject({
      companyId: 7,
      saleNumber: "FPOS-0001",
      totalAmount: "20.00",
      paymentType: "CASH",
      createdBy: "55",
    });
    expect(harness.inserted.some((entry) => entry.values?.txType === "BALE_SALE" && entry.values.amountUsd === "20.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.txType === "POS_EXPENSE" && entry.values.amountUsd === "2.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.ledgerAccountId === 12 && entry.values.debitAmount === "18.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.ledgerAccountId === 30 && entry.values.debitAmount === "2.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.ledgerAccountId === 900 && entry.values.creditAmount === "20.00")).toBe(true);
    expect(harness.getOrCreateLedgerAccount).toHaveBeenCalledWith(
      7,
      "FACTORY_BALE_SALES_INCOME",
      "Factory Bale Sales Income",
      "Revenue"
    );
  });

  it("records a credit sale and deposit against the customer running balance", async () => {
    harness.dbSelectResults.push([{ count: 4 }]);
    harness.returningResults.push([{ id: 202, saleNumber: "FPOS-0005" }]);
    harness.txSelectResults.push([{ net: "10" }]);
    const res = resHarness();

    await routes.get("POST /api/factory/pos/sale")!(
      req({
        body: {
          customerId: "9",
          customerName: "Credit Customer",
          paymentType: "CREDIT",
          depositAmount: "5",
          items: [{ productName: "Loose Bale", quantity: 2, unitPrice: "10" }],
        },
      }),
      res
    );

    expect(res.statusCode).toBe(200);
    expect(harness.inserted.some((entry) => entry.values?.referenceType === "FACTORY_POS_SALE" && entry.values.balance === "30.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.referenceType === "FACTORY_POS_DEPOSIT" && entry.values.balance === "25.00")).toBe(true);
    expect(harness.inserted.some((entry) => entry.values?.txType === "BALE_SALE" && String(entry.values.description).includes("[CREDIT]"))).toBe(true);
  });

  it("locks physical bales and aborts the whole sale when requested stock is short", async () => {
    harness.dbSelectResults.push([{ count: 0 }]);
    harness.returningResults.push([{ id: 303, saleNumber: "FPOS-0001" }]);
    harness.txSelectResults.push([{ id: 1 }]);
    const res = resHarness();

    await routes.get("POST /api/factory/pos/sale")!(
      req({
        body: {
          locationId: 4,
          paymentType: "CASH",
          items: [{ productId: 88, productName: "Shirts", quantity: 2, unitPrice: "10" }],
        },
      }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body.message).toContain("INSUFFICIENT_BALE_STOCK");
    expect(res.body.message).toContain("only 1 available");
    expect(harness.txSelectResults).toHaveLength(0);
    expect(harness.updated).toHaveLength(0);
  });

  it("guards edits by company, existence, void state, and line presence before a transaction", async () => {
    const noCompany = resHarness();
    await routes.get("PUT /api/factory/pos/sales/:id")!(
      req({ method: "PUT", path: "/api/factory/pos/sales/1", session: {}, params: { id: "1" }, body: { items: [{}] } }),
      noCompany
    );
    expect(noCompany.statusCode).toBe(400);

    harness.dbSelectResults.push([]);
    const missing = resHarness();
    await routes.get("PUT /api/factory/pos/sales/:id")!(
      req({ method: "PUT", params: { id: "1" }, body: { items: [{ productName: "Bale", quantity: 1 }] } }),
      missing
    );
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toEqual({ message: "Sale not found" });

    harness.dbSelectResults.push([{ id: 1, status: "VOIDED" }]);
    const voided = resHarness();
    await routes.get("PUT /api/factory/pos/sales/:id")!(
      req({ method: "PUT", params: { id: "1" }, body: { items: [{ productName: "Bale", quantity: 1 }] } }),
      voided
    );
    expect(voided.statusCode).toBe(400);
    expect(voided.body).toEqual({ message: "Cannot edit a voided sale" });

    harness.dbSelectResults.push([{ id: 2, status: "COMPLETED", txDate: "2026-09-17", saleNumber: "FPOS-0002" }]);
    const noLines = resHarness();
    await routes.get("PUT /api/factory/pos/sales/:id")!(
      req({ method: "PUT", params: { id: "2" }, body: { items: [] } }),
      noLines
    );
    expect(noLines.statusCode).toBe(400);
    expect(noLines.body).toEqual({ message: "At least one item is required" });
    expect(harness.db.transaction).not.toHaveBeenCalled();
  });
});