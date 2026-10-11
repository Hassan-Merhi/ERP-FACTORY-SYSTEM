import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  const db: any = {
    select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
    selectDistinct: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
  };
  return {
    db,
    selectResults,
    getCompanyById: vi.fn(),
    isParentCompanyContext: vi.fn(),
    generateAccountStatementPdf: vi.fn(),
    getCustomerByLedgerId: vi.fn(),
    getPartyBalance: vi.fn(),
    loadCustomerNotInLedger: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/storage", () => ({ storage: { getCompanyById: harness.getCompanyById } }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/routes/helpers/supplierBalanceHelpers", () => ({
  isParentCompanyContext: harness.isParentCompanyContext,
}));
vi.mock("../server/routes/helpers/partyOpeningSide", () => ({ loadPartyOpeningSides: async () => new Map() }));
vi.mock("../server/lib/accountStatementPdfGenerator", () => ({
  generateAccountStatementPdf: harness.generateAccountStatementPdf,
}));
// Wave 10: a ledger account a customer owns opens at the balance engine's
// customer opening, with what is not yet in the ledger reported separately.
vi.mock("../server/lib/factoryCustomerLedger", () => ({ getCustomerByLedgerId: harness.getCustomerByLedgerId }));
vi.mock("../server/services/accounting/balances/ledgerBalanceEngine", () => ({
  getPartyBalance: harness.getPartyBalance,
}));
vi.mock("../server/services/accounting/balances/customerLedgerStatement", () => ({
  loadCustomerNotInLedger: harness.loadCustomerNotInLedger,
  loadCustomerLedgerEntryRows: vi.fn(async () => []),
}));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/lib/bufferCompatibility", () => ({ toArrayBuffer: (value: unknown) => value }));
vi.mock("fs", () => ({ default: { existsSync: () => false } }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  desc: (column: unknown) => ({ type: "desc", column }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
  isNotNull: (column: unknown) => ({ type: "isNotNull", column }),
  or: (...conditions: unknown[]) => ({ type: "or", conditions }),
  inArray: (column: unknown, values: unknown) => ({ type: "inArray", column, values }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  bankAccounts: { id: "bank.id", name: "bank.name", openingBalance: "bank.ob", openingBalanceSide: "bank.side" },
  companies: { id: "companies.id" },
  customerBalances: {
    customerId: "cb.customerId",
    companyId: "cb.companyId",
    referenceType: "cb.referenceType",
    transactionDate: "cb.date",
    debitAmount: "cb.dr",
    creditAmount: "cb.cr",
  },
  customerOrders: {
    customerId: "orders.customerId",
    companyId: "orders.companyId",
    status: "orders.status",
    orderDate: "orders.date",
    grandTotal: "orders.total",
  },
  customers: {
    id: "customers.id",
    legalName: "customers.legalName",
    ledgerAccountId: "customers.ledgerAccountId",
    openingBalance: "customers.ob",
    openingBalanceSide: "customers.side",
  },
  employees: {
    id: "employees.id",
    firstName: "employees.firstName",
    lastName: "employees.lastName",
    openingBalance: "employees.ob",
  },
  fixedAssets: { id: "assets.id", name: "assets.name", openingBalance: "assets.ob" },
  ledgerAccounts: {
    id: "ledger.id",
    name: "ledger.name",
    openingBalance: "ledger.ob",
    openingBalanceSide: "ledger.side",
  },
  suppliers: { id: "suppliers.id", legalName: "suppliers.legalName", openingBalance: "suppliers.ob" },
  voucherEntries: {
    voucherId: "entries.voucherId",
    ledgerAccountId: "entries.ledgerId",
    bankAccountId: "entries.bankId",
    fixedAssetId: "entries.assetId",
    supplierId: "entries.supplierId",
    employeeId: "entries.employeeId",
    customerId: "entries.customerId",
    debitAmount: "entries.dr",
    creditAmount: "entries.cr",
  },
  vouchers: {
    id: "vouchers.id",
    companyId: "vouchers.companyId",
    voucherNumber: "vouchers.number",
    voucherType: "vouchers.type",
    voucherDate: "vouchers.date",
    totalAmount: "vouchers.total",
    description: "vouchers.description",
    locationName: "vouchers.locationName",
    deletedAt: "vouchers.deletedAt",
    optional: "vouchers.optional",
  },
}));

import { registerAccountStatementRoutes } from "../server/routes/accountStatementRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const register =
    (method: string) =>
    (path: string, ...handlers: any[]) =>
      routes.set(`${method} ${path}`, handlers.at(-1));
  const app: any = { get: register("GET"), post: register("POST") };
  registerAccountStatementRoutes(app);
  return routes;
}

function request(overrides: Record<string, unknown> = {}) {
  return { session: { currentCompanyId: 4 }, params: {}, query: {}, body: {}, ...overrides } as any;
}

function responseHarness() {
  const headers = new Map<string, unknown>();
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
    setHeader: vi.fn((name: string, value: unknown) => headers.set(name, value)),
    end: vi.fn((body?: unknown) => {
      res.body = body;
      return res;
    }),
    headers,
  };
  return res;
}

describe("account statement route behavior", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.isParentCompanyContext.mockResolvedValue(true);
    harness.getCompanyById.mockResolvedValue({ id: 4, companyType: "erp" });
    harness.generateAccountStatementPdf.mockResolvedValue(Buffer.from("%PDF-1.4\npdf-statement"));
    harness.getCustomerByLedgerId.mockResolvedValue(null);
  });

  it("returns recoverable deleted vouchers for a supported account type", async () => {
    harness.selectResults.push([{ id: 90, voucherNumber: "PAY-90", voucherType: "Payment", deletedAt: new Date() }]);
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/deleted-vouchers")!(
      request({ params: { type: "ledger", id: "12" } }),
      res
    );
    expect(res.body).toEqual([expect.objectContaining({ id: 90, voucherNumber: "PAY-90" })]);
  });

  it("returns no deleted vouchers for unsupported account types without querying", async () => {
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/deleted-vouchers")!(
      request({ params: { type: "mystery", id: "12" } }),
      res
    );
    expect(res.body).toEqual([]);
    expect(harness.db.selectDistinct).not.toHaveBeenCalled();
  });

  // Wave 13: the supplier pre-period balance is the balance engine's period
  // opening (the supplier's own opening, counted in its own company only, with
  // its side, plus earlier lines of this company). It used to add the opening
  // when the global parent-company setting named this company, without its side.
  it("opens a supplier at the balance engine's period opening, Cr positive", async () => {
    harness.getPartyBalance.mockResolvedValue({ opening: "-125.00" });
    const parent = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "supplier", id: "8" }, query: { endDate: "2026-08-01" } }),
      parent
    );
    expect(parent.body).toEqual({ balance: 125 });
    expect(harness.getPartyBalance).toHaveBeenCalledWith(harness.db, {
      companyId: 4,
      kind: "supplier",
      id: 8,
      from: "2026-08-01",
    });
    expect(harness.isParentCompanyContext).not.toHaveBeenCalled();
  });

  // Wave 17 A: every family opens at the balance engine's period opening (the
  // master's opening with its side, a sideless ledger opening by its type, and
  // the lines the engine attributes to it before endDate — a line naming a
  // ledger and a bank is the ledger's). It used to sum every line naming the
  // bank on top of the opening, with a sideless opening read as Dr.
  it("opens a bank at the balance engine's period opening", async () => {
    harness.selectResults.push([{ id: 3 }]);
    harness.getPartyBalance.mockResolvedValue({ opening: "-30.00" });
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "bank", id: "3" }, query: { endDate: "2026-08-01" } }),
      res
    );
    expect(res.body).toEqual({ balance: -30 });
    expect(harness.getPartyBalance).toHaveBeenCalledWith(harness.db, {
      companyId: 4,
      kind: "bank",
      id: 3,
      from: "2026-08-01",
    });
  });

  it("returns the engine's exact opening and 404 for an account outside the company", async () => {
    harness.selectResults.push([{ id: 3 }]);
    harness.getPartyBalance.mockResolvedValue({ opening: "0.30" });
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "bank", id: "3" }, query: { endDate: "2026-08-01" } }),
      res
    );
    expect(res.body).toEqual({ balance: 0.3 });
    harness.selectResults.push([]);
    const missing = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "bank", id: "99" }, query: { endDate: "2026-08-01" } }),
      missing
    );
    expect(missing.statusCode).toBe(404);
  });

  it("opens a customer-owned ledger at the balance engine's customer opening before the period", async () => {
    // The factory composite (orders + cache + vouchers without CHARGE-/INV-) is
    // retired: the ledger figure is the engine's, the operational part is reported apart.
    harness.getCompanyById.mockResolvedValue({ id: 4, companyType: "factory" });
    harness.selectResults.push([{ id: 12 }]);
    harness.getCustomerByLedgerId.mockResolvedValue({ id: 44, companyId: 4 });
    harness.getPartyBalance.mockResolvedValue({ opening: "150.00" });
    harness.loadCustomerNotInLedger.mockResolvedValue({ prePeriodTotal: "120.00", rows: [] });
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "ledger", id: "12" }, query: { endDate: "2026-08-01" } }),
      res
    );
    expect(res.body).toEqual({ balance: 150, notInLedgerBefore: "120.00" });
    expect(harness.getPartyBalance).toHaveBeenCalledWith(harness.db, {
      companyId: 4,
      kind: "customer",
      id: 44,
      from: "2026-08-01",
    });
  });

  it("rejects unknown account types and invalid identifiers", async () => {
    const unknown = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "mystery", id: "4" } }),
      unknown
    );
    expect(unknown.statusCode).toBe(400);
    expect(unknown.body).toEqual({ message: "Unknown account type" });

    const invalid = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "ledger", id: "bad" } }),
      invalid
    );
    expect(invalid.statusCode).toBe(400);
  });

  it("rejects repeated query values at account statement boundaries", async () => {
    const prePeriod = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/pre-period-balance")!(
      request({ params: { type: "bank", id: "3" }, query: { endDate: ["2026-08-01", "2026-08-02"] } }),
      prePeriod
    );
    expect(prePeriod.statusCode).toBe(400);
    expect(harness.db.select).not.toHaveBeenCalled();

    const pdf = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/statement-pdf")!(
      request({ params: { type: "supplier", id: "8" }, query: { startDate: ["2026-08-01"] } }),
      pdf
    );
    expect(pdf.statusCode).toBe(400);
    expect(harness.generateAccountStatementPdf).not.toHaveBeenCalled();

    const excel = responseHarness();
    await routes.get("GET /api/accounts/statement/export-excel")!(request({ query: { accountId: ["8", "9"] } }), excel);
    expect(excel.statusCode).toBe(400);
  });

  it("generates a statement PDF with a sanitized human-readable filename", async () => {
    harness.selectResults.push([{ name: "Supplier / Alpha" }]);
    const res = responseHarness();
    await routes.get("GET /api/accounts/:type/:id/statement-pdf")!(
      request({
        params: { type: "supplier", id: "8" },
        query: { startDate: "2026-08-01", endDate: "2026-08-12", lang: "fr" },
      }),
      res
    );

    expect(harness.generateAccountStatementPdf).toHaveBeenCalledWith({
      accountType: "supplier",
      accountId: 8,
      companyId: 4,
      startDate: "2026-08-01",
      endDate: "2026-08-12",
      lang: "fr",
    });
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toBe("attachment; filename=statement_Supplier___Alpha.pdf");
    expect(res.body).toEqual(Buffer.from("%PDF-1.4\npdf-statement"));
  });
});
