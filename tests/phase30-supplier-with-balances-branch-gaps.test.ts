import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  dbSelect: vi.fn(),
  dbExecute: vi.fn(),
  buildBrokerStatement: vi.fn(),
  isPayableContainer: vi.fn(),
  isSupplierPaidFreight: vi.fn(),
  resolveDisplayFx: vi.fn(),
  resolveStoredFxRate: vi.fn(),
  loggerError: vi.fn(),
  queryResults: [] as unknown[],
}));

vi.mock("../server/auth", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("../server/db", () => ({
  db: {
    select: harness.dbSelect,
    execute: harness.dbExecute,
  },
}));

vi.mock("../server/routes/factory/suppliers/balance/_helpers", () => ({
  buildBrokerStatement: harness.buildBrokerStatement,
  isPayableContainer: harness.isPayableContainer,
  isSupplierPaidFreight: harness.isSupplierPaidFreight,
  resolveDisplayFx: harness.resolveDisplayFx,
}));

vi.mock("../server/services/factory/currencyConversion", () => ({
  resolveStoredFxRate: harness.resolveStoredFxRate,
}));

vi.mock("../server/lib/logger", () => ({
  logger: {
    error: harness.loggerError,
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { registerSupplierWithBalancesRoutes } from "../server/routes/factory/suppliers/balance/with-balances";

type Handler = (req: any, res: any) => Promise<unknown> | unknown;

function queryFor(value: unknown) {
  const query: any = {};
  query.from = vi.fn(() => query);
  query.where = vi.fn(() => query);
  query.orderBy = vi.fn(() => query);
  query.innerJoin = vi.fn(() => query);
  query.limit = vi.fn(() => query);
  query.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
    Promise.resolve(value).then(resolve, reject);
  return query;
}

function queueQueries(...results: unknown[]) {
  harness.queryResults.splice(0, harness.queryResults.length, ...results);
}

function captureHandler() {
  let handler: Handler | undefined;
  const app = {
    get: vi.fn((path: string, ...handlers: Handler[]) => {
      if (path === "/api/factory/suppliers/with-balances") handler = handlers.at(-1);
    }),
  };
  registerSupplierWithBalancesRoutes(app as any);
  return handler!;
}

function responseHarness() {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res.statusCode = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res.body = body;
    return res;
  });
  return res;
}

const baseSupplier = {
  companyId: 7,
  code: null,
  openingBalance: "0",
  createdAt: new Date("2026-01-01T00:00:00Z"),
};

const broker = { ...baseSupplier, id: 1, name: "Alpha Broker", parentId: null, openingBalance: "25" };
const child = { ...baseSupplier, id: 2, name: "Beta Child", parentId: 1 };
const leaf = { ...baseSupplier, id: 3, name: "Zulu Leaf", parentId: null };

function container(overrides: Record<string, unknown>) {
  return {
    id: 100,
    supplierId: 1,
    containerNumber: "CONT-100",
    status: "OFFLOADED",
    totalKg: "100",
    actualReceivedKg: null,
    ratePerKg: "2",
    freight: "0",
    freightPaidBy: "supplier",
    freightCurrencyCode: "USD",
    currencyCode: "USD",
    fxRateToUsd: "1",
    fxRateConfirmed: true,
    fxRateDateOffload: "2026-01-01",
    commissionAmount: "0",
    commissionCurrencyCode: "USD",
    otherCharges: "0",
    otherChargesSupplierId: null,
    otherChargesCurrencyCode: "USD",
    arrivalDate: "2026-01-01",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.queryResults.length = 0;
  harness.dbSelect.mockImplementation(() => queryFor(harness.queryResults.shift() ?? []));
  harness.dbExecute.mockResolvedValue({ rows: [] });
  harness.isPayableContainer.mockImplementation((c: any) =>
    ["OFFLOADED", "RECEIVED", "PARTIALLY_RECEIVED"].includes(String(c.status || "").toUpperCase())
  );
  harness.isSupplierPaidFreight.mockImplementation((c: any) => c.freightPaidBy !== "own");
  harness.resolveDisplayFx.mockImplementation(
    (cc: string, configured?: number, stored?: string, confirmed?: boolean) => {
      if ((cc || "USD").toUpperCase() === "USD") return 1;
      if (typeof configured === "number") return configured;
      const parsed = Number(stored || 0);
      return confirmed && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    }
  );
  harness.resolveStoredFxRate.mockImplementation((cc: string, stored?: string, confirmed?: boolean) => {
    if ((cc || "USD").toUpperCase() === "USD") return { fxRate: 1, looksSet: true };
    const parsed = Number(stored || 0);
    const looksSet = Number.isFinite(parsed) && parsed > 0 && (confirmed !== false || confirmed === undefined);
    return { fxRate: looksSet ? parsed : 0, looksSet };
  });
  harness.buildBrokerStatement.mockResolvedValue(null);
});

describe("Phase 30 supplier with-balances branch gaps", () => {
  it("rejects requests without a selected company before querying balances", async () => {
    const handler = captureHandler();
    const res = responseHarness();

    await handler({ session: {}, query: {} }, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
    expect(harness.dbSelect).not.toHaveBeenCalled();
  });

  it("returns an empty result without voucher or offload lookups when the company has no suppliers", async () => {
    queueQueries([], [], [], []);
    harness.dbExecute.mockResolvedValue({ rows: [{ currency_code: "EUR", rate_to_usd: "1.2" }] });
    const handler = captureHandler();
    const res = responseHarness();

    await handler({ session: { currentCompanyId: 7 }, query: {} }, res);

    expect(res.body).toEqual([]);
    expect(harness.dbSelect).toHaveBeenCalledTimes(4);
    expect(harness.buildBrokerStatement).not.toHaveBeenCalled();
  });

  it("computes leaf and broker balances across native currencies, freight, payments, FX, charges and broker ledgers", async () => {
    const containers = [
      container({
        id: 101,
        supplierId: 1,
        containerNumber: "BROKER-USD",
        totalKg: "100",
        ratePerKg: "2",
        freight: "10",
        commissionAmount: "5",
        otherCharges: "10",
        otherChargesSupplierId: 1,
      }),
      container({
        id: 201,
        supplierId: 2,
        containerNumber: "CHILD-AUD",
        currencyCode: "AUD",
        fxRateToUsd: "0.70",
        totalKg: "100",
        ratePerKg: "3",
        freight: "50",
        freightCurrencyCode: "USD",
        commissionAmount: "20",
        commissionCurrencyCode: "USD",
        otherCharges: "15",
        otherChargesSupplierId: 2,
        otherChargesCurrencyCode: "EUR",
      }),
      container({
        id: 202,
        supplierId: 2,
        containerNumber: "CHILD-OTW",
        status: "PENDING",
        currencyCode: "AUD",
        fxRateToUsd: "0.70",
        totalKg: "40",
        ratePerKg: "1",
        freight: "5",
        freightCurrencyCode: "AUD",
        fxRateDateOffload: null,
      }),
      container({
        id: 301,
        supplierId: 3,
        containerNumber: "LEAF-EUR",
        status: "RECEIVED",
        currencyCode: "EUR",
        fxRateToUsd: "1.05",
        totalKg: "50",
        actualReceivedKg: "48",
        ratePerKg: "4",
        freight: "10",
        freightCurrencyCode: "EUR",
        commissionAmount: "10",
        commissionCurrencyCode: "EUR",
        arrivalDate: "2026-03-01",
      }),
      container({
        id: 302,
        supplierId: 3,
        containerNumber: "LEAF-OTW",
        status: "IN_TRANSIT",
        totalKg: "20",
        ratePerKg: "1",
        fxRateDateOffload: null,
      }),
    ];
    const payments = [
      {
        id: 1,
        companyId: 7,
        supplierId: 2,
        date: "2026-02-01",
        amount: "30",
        currencyCode: "AUD",
        fxRateToUsd: "0.7",
        amountUsd: "21",
        paidFromAccountId: null,
        notes: null,
        createdAt: new Date(),
      },
      {
        id: 2,
        companyId: 7,
        supplierId: 3,
        date: "2026-02-02",
        amount: "25",
        currencyCode: "USD",
        fxRateToUsd: "1",
        amountUsd: "25",
        paidFromAccountId: null,
        notes: null,
        createdAt: new Date(),
      },
    ];
    const fxTransfers = [
      {
        id: 1,
        fromSupplierId: 2,
        toSupplierId: 1,
        fromCurrencyCode: "AUD",
        fromAmount: "100",
        toAmountUsd: "60",
      },
      {
        id: 2,
        fromSupplierId: 1,
        toSupplierId: 2,
        fromCurrencyCode: "USD",
        fromAmount: "20",
        toAmountUsd: "20",
      },
    ];
    const voucherRows = [
      { factorySupplierId: null, debitAmount: "99", currency: "USD", exchangeRate: "1", optional: false },
      { factorySupplierId: 1, debitAmount: "8", currency: "USD", exchangeRate: "1", optional: true },
      { factorySupplierId: 3, debitAmount: "22", currency: "EUR", exchangeRate: "1.1", optional: false },
      { factorySupplierId: 2, debitAmount: "10", currency: "AUD", exchangeRate: "0", optional: false },
    ];
    const offloadCharges = [
      { supplierId: 2, amount: "5", currencyCode: "AUD", fxRateToUsd: "0.7" },
      { supplierId: 3, amount: "2", currencyCode: "USD", fxRateToUsd: "1" },
    ];
    queueQueries([broker, child, leaf], containers, payments, fxTransfers, voucherRows, offloadCharges);
    harness.dbExecute.mockResolvedValue({
      rows: [
        { currency_code: "AUD", rate_to_usd: "0.75" },
        { currency_code: "EUR", rate_to_usd: "1.10" },
      ],
    });
    harness.buildBrokerStatement.mockResolvedValue({
      supplier: broker,
      linkedSuppliers: [child],
      currencyLedgers: [
        { currencyCode: "EUR", netBalance: "100" },
        { currencyCode: "AUD", netBalance: "200" },
        { currencyCode: "USD", netBalance: "300" },
      ],
    });
    const handler = captureHandler();
    const res = responseHarness();

    await handler({ session: { factoryCompanyId: 7, currentCompanyId: 99 }, query: { includeOtw: "false" } }, res);

    expect(res.statusCode).toBeUndefined();
    expect(res.body.map((row: any) => row.name)).toEqual(["Alpha Broker", "Beta Child", "Zulu Leaf"]);

    const brokerResult = res.body[0];
    expect(brokerResult.totalContainers).toBe(3);
    expect(brokerResult.brokerPoolUsd).toBe("300.00");
    expect(brokerResult.totalValue).toBe("560.00");
    expect(brokerResult.exposureCurrencyBalances).toEqual([
      { currencyCode: "EUR", balance: 100, fxRateToUsd: 1.1 },
      { currencyCode: "AUD", balance: 200, fxRateToUsd: 0.75 },
    ]);
    expect(brokerResult.linkedSupplierExposure).toHaveLength(1);
    expect(brokerResult.pendingContainers).toBe(1);

    const childResult = res.body[1];
    expect(childResult.pendingContainers).toBe(1);
    expect(childResult.autoSettledFreightUsd).toBe("50.00");
    expect(childResult.fxUnresolved).toBe(true);

    const leafResult = res.body[2];
    expect(leafResult.receivedContainers).toBe(1);
    expect(leafResult.pendingContainers).toBe(1);
    expect(leafResult.totalPaid).toBe("25.00");
    expect(leafResult.currencyBalances.some((row: any) => row.currencyCode === "EUR")).toBe(true);
    expect(leafResult.dueContainersCount).toBeGreaterThan(0);
    expect(harness.buildBrokerStatement).toHaveBeenCalledWith(1, 7, false);
  });

  it("includes pending and in-transit values only when includeOtw is enabled", async () => {
    const supplier = { ...baseSupplier, id: 9, name: "OTW Supplier", parentId: null };
    const pending = container({
      id: 901,
      supplierId: 9,
      status: "PENDING",
      totalKg: "10",
      ratePerKg: "5",
      freight: "5",
      freightCurrencyCode: "USD",
      fxRateDateOffload: null,
    });
    const handler = captureHandler();

    queueQueries([supplier], [pending], [], [], [], []);
    const withoutOtw = responseHarness();
    await handler({ session: { currentCompanyId: 7 }, query: {} }, withoutOtw);

    queueQueries([supplier], [pending], [], [], [], []);
    const withOtw = responseHarness();
    await handler({ session: { currentCompanyId: 7 }, query: { includeOtw: "true" } }, withOtw);

    expect(withoutOtw.body[0].totalValue).toBe("0.00");
    expect(withOtw.body[0].totalValue).toBe("55.00");
    expect(withOtw.body[0].otwByCurrency).toEqual({ USD: 1 });
  });

  it("falls back to computed broker exposure when the broker statement is unavailable", async () => {
    const parent = { ...baseSupplier, id: 20, name: "Parent", parentId: null };
    const linked = { ...baseSupplier, id: 21, name: "Linked", parentId: 20 };
    const linkedContainer = container({
      id: 2101,
      supplierId: 21,
      currencyCode: "EUR",
      totalKg: "10",
      ratePerKg: "10",
      freight: "0",
      fxRateToUsd: "1.2",
      fxRateConfirmed: true,
    });
    queueQueries([parent, linked], [linkedContainer], [], [], [], []);
    harness.dbExecute.mockResolvedValue({ rows: [{ currency_code: "EUR", rate_to_usd: "1.2" }] });
    harness.buildBrokerStatement.mockResolvedValue(null);
    const handler = captureHandler();
    const res = responseHarness();

    await handler({ session: { currentCompanyId: 7 }, query: {} }, res);

    const parentResult = res.body.find((row: any) => row.id === 20);
    expect(parentResult.brokerPoolUsd).toBe("0.00");
    expect(parentResult.exposureCurrencyBalances).toEqual([{ currencyCode: "EUR", balance: 100, fxRateToUsd: 1.2 }]);
    expect(parentResult.totalValue).toBe("120.00");
  });

  it("returns a controlled 500 response when a balance query fails", async () => {
    harness.dbSelect.mockImplementationOnce(() => {
      throw new Error("supplier balance query failed");
    });
    const handler = captureHandler();
    const res = responseHarness();

    await handler({ session: { currentCompanyId: 7 }, query: {} }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "supplier balance query failed" });
    expect(harness.loggerError).toHaveBeenCalled();
  });
});
