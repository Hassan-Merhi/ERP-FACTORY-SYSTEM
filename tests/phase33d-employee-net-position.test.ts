import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const executeResults: any[] = [];
  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      limit: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      leftJoin: vi.fn(() => builder),
      groupBy: vi.fn(() => builder),
      orderBy: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };
  return {
    selectResults,
    executeResults,
    db: {
      select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])),
      execute: vi.fn(async () => executeResults.shift() ?? { rows: [] }),
    },
    poolQuery: vi.fn(async () => ({ rows: [] })),
    getClientDate: vi.fn(() => "2026-09-17"),
    classifyNetPositionAccounts: vi.fn(),
    computeNetPositionInventory: vi.fn(),
    computeNetPositionSupplierBalances: vi.fn(),
    loadNetPositionParties: vi.fn(),
    loggerError: vi.fn(),
  };
});

// Wave 10: factory suppliers, customers and employees come from the balance
// engine; the factory-specific "not yet in the ledger" helpers stay real.
vi.mock("../server/services/accounting/balances/netPositionParties", async () => {
  const notInLedgerSection = (lines: Array<{ value: number; count: number }>) => ({
    label: "Not yet in the ledger",
    total: Math.round(lines.reduce((sum, line) => sum + line.value, 0) * 100) / 100,
    lines,
  });
  return { loadNetPositionParties: harness.loadNetPositionParties, notInLedgerSection };
});

const payrollLine = (value: number) => ({
  name: "Payroll Payable",
  code: "EMPLOYEE_PAYROLL_PAYABLE",
  value,
  category: "Liability",
  partyKind: "employee",
  partyId: null,
});
const emptyParties = () => ({
  forUs: [],
  onUs: [payrollLine(0)],
  forUsTotal: 0,
  onUsTotal: 0,
  customerLedgerIds: new Set<number>(),
  payrollSigned: 0,
  notInLedger: { label: "Not yet in the ledger", total: 0, lines: [] },
});

vi.mock("../server/db", () => ({
  db: harness.db,
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: harness.getClientDate }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: harness.loggerError } }));
vi.mock("../server/netPositionHelper", () => ({
  classifyNetPositionAccounts: harness.classifyNetPositionAccounts,
  PERPETUAL_STOCK_ACCOUNT_CODES: new Set<string>(),
}));
// Before any perpetual-inventory cut-over: the computed factory values apply.
vi.mock("../server/services/accounting/perpetualInventory/reportBasis", () => ({
  ledgerCarriesStock: async () => false,
}));
vi.mock("../server/services/rental/rentalPeriodService", () => ({
  getRentalBillingDay: () => 1,
  getRentalPeriodDueDate: (year: number, month: number) => `${year}-${String(month).padStart(2, "0")}-01`,
}));
vi.mock("../server/routes/factory/employee-pos/netPositionInventory", () => ({
  computeNetPositionInventory: harness.computeNetPositionInventory,
}));
vi.mock("../server/routes/factory/employee-pos/netPositionSupplierBalances", () => ({
  computeNetPositionSupplierBalances: harness.computeNetPositionSupplierBalances,
}));
vi.mock("../server/lib/queryResult", () => ({ resultRows: (value: any) => value?.rows ?? [] }));

import { registerEmployeeNetPositionRoutes } from "../server/routes/factory/employee-pos/employeeNetPositionRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: Handler[]) => routes.set(`GET ${path}`, handlers.at(-1)!),
  };
  registerEmployeeNetPositionRoutes(app);
  return routes;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    session: { factoryCompanyId: 7, currentCompanyId: 8 },
    query: {},
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

describe("Phase 33D employee/factory net position", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.executeResults.splice(0);
    harness.getClientDate.mockReturnValue("2026-09-17");
    harness.classifyNetPositionAccounts.mockReturnValue({ forUsAccounts: [], onUsAccounts: [] });
    harness.computeNetPositionSupplierBalances.mockResolvedValue({
      supplierLockedRateMapNp: new Map(),
      allContainersF: [],
      supplierItems: [],
      totalSupplierLiabilities: 0,
      totalSupplierOverpayments: 0,
    });
    harness.computeNetPositionInventory.mockResolvedValue({
      inventorySellValue: 0,
      rawMaterialStockValue: 0,
      stockOtwValue: 0,
      balanceOnTableValue: 0,
    });
    harness.loadNetPositionParties.mockResolvedValue(emptyParties());
  });

  it("returns 400 when neither the session nor an active factory company can resolve a company", async () => {
    harness.selectResults.push([]);
    const res = resHarness();

    await routes.get("GET /api/factory/net-position")!(
      req({ session: { factoryCompanyId: null, currentCompanyId: null } }),
      res
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
    expect(harness.computeNetPositionSupplierBalances).not.toHaveBeenCalled();
  });

  it("prefers an active factory company over a non-factory current company and pins it to the session", async () => {
    harness.selectResults.push([{ id: 8, companyType: "erp" }], [{ id: 17 }]);
    harness.executeResults.push(Promise.reject(new Error("stop after company resolution")));
    const request = req({ session: { factoryCompanyId: null, currentCompanyId: 8 } });
    const res = resHarness();

    await routes.get("GET /api/factory/net-position")!(request, res);

    expect(request.session.factoryCompanyId).toBe(17);
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "stop after company resolution" });
  });

  it("calculates a zero-state net position without manufacturing ledger or payroll balances", async () => {
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push([], [], [], [], [], []);
    const res = resHarness();

    await routes.get("GET /api/factory/net-position")!(req(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      asOf: "2026-09-17",
      forUsTotal: 0,
      onUsTotal: 0,
      netPosition: 0,
      inventoryValue: 0,
      rawMaterialValue: 0,
      payrollPayable: 0,
      pendingOrders: [],
      verifiedOrders: [],
      loadingOrders: [],
    });
    expect(res.body.forUs.accounts).toEqual([
      expect.objectContaining({ code: "INVENTORY", value: 0 }),
      expect.objectContaining({ code: "RAW_MATERIAL", value: 0 }),
    ]);
    expect(res.body.onUs.accounts).toEqual([expect.objectContaining({ code: "EMPLOYEE_PAYROLL_PAYABLE", value: 0 })]);
  });

  it("takes parties from the balance engine, keeps ledger balances, and lists unfinalized orders apart", async () => {
    harness.classifyNetPositionAccounts.mockReturnValue({
      forUsAccounts: [
        { id: 1, name: "Operating Cash", code: "CASH", category: "Asset", value: 100 },
        { id: 2, name: "Legacy Inventory", code: "LEGACY_INV", category: "Inventory", value: 999 },
        { id: 3, name: "Factory Worker Advances", code: "ADV", category: "Asset", value: 88 },
        { id: 4, name: "Prepaid Rent - Legacy", code: "RENT", category: "Asset", value: 50 },
        { id: 5, name: "Insurance - Member", code: "INS", category: "Asset", value: 20 },
        { id: 6, name: "Customer Ledger", code: "CUST-6", category: "Asset", value: 77 },
      ],
      onUsAccounts: [
        { name: "Payroll Payable", code: "PAYROLL_PAYABLE", category: "Liability", value: 500 },
        { name: "Accrued Rent", code: "ACCR-RENT-PAY", category: "Liability", value: 100 },
        { name: "Factory Worker Advances", code: "ADV", category: "Liability", value: 50 },
        { name: "Insurance - Member", code: "INS", category: "Liability", value: 25 },
        { name: "Other Payable", code: "OTHER", category: "Liability", value: 30 },
      ],
    });
    harness.loadNetPositionParties.mockResolvedValue({
      forUs: [
        {
          name: "Supplier Overpaid",
          code: "SUPPLIER_OVERPAID",
          value: 10,
          category: "Supplier Overpayments",
          partyKind: "factorySupplier",
          partyId: 2,
        },
        {
          name: "Bob Owes",
          code: "EMPLOYEE_RECEIVABLE",
          value: 12,
          category: "Employee Receivable",
          partyKind: "employee",
          partyId: 9,
        },
        {
          id: 6,
          name: "Customer Dr",
          code: "CUSTOMER_DR",
          value: 70,
          category: "Customer",
          partyKind: "customer",
          partyId: 5,
        },
      ],
      onUs: [
        {
          name: "Supplier Due",
          code: "SUPPLIER",
          value: 40,
          category: "Supplier",
          partyKind: "factorySupplier",
          partyId: 1,
        },
        payrollLine(20),
      ],
      forUsTotal: 92,
      onUsTotal: 60,
      // The customer's linked ledger is rolled into the customer line.
      customerLedgerIds: new Set<number>([6]),
      payrollSigned: 20,
      notInLedger: {
        label: "Not yet in the ledger",
        total: 300,
        lines: [
          {
            label: "Factory invoices not yet in the ledger",
            code: "NOT_IN_LEDGER_FACTORY_INVOICE",
            value: 300,
            category: "Not yet in the ledger",
            count: 2,
          },
        ],
      },
    });
    harness.computeNetPositionInventory.mockResolvedValue({
      inventorySellValue: 200,
      rawMaterialStockValue: 100,
      stockOtwValue: 50,
      balanceOnTableValue: 25,
    });

    harness.executeResults.push(
      { rows: [{ currency_code: "CDF", rate_to_usd: "0.00035" }] },
      { rows: [{ total: "15" }] }
    );
    harness.selectResults.push(
      [],
      [],
      [
        {
          id: 1,
          status: "PENDING_VERIFICATION",
          orderDate: "2026-09-10",
          grandTotal: "60",
          totalQtyBales: 1,
          customerId: 1,
          customerName: "Pending Customer",
        },
        {
          id: 2,
          status: "VERIFIED",
          orderDate: "2026-09-11",
          grandTotal: "70",
          totalQtyBales: 2,
          customerId: 2,
          customerName: "Verified Customer",
        },
        {
          id: 3,
          status: "LOADING",
          orderDate: "2026-09-12",
          grandTotal: "80",
          totalQtyBales: 3,
          customerId: 3,
          customerName: "Loading Customer",
        },
      ],
      []
    );

    const res = resHarness();
    await routes.get("GET /api/factory/net-position")!(req({ query: { asOf: "2026-09-15" } }), res);

    expect(res.statusCode).toBe(200);
    // What We Have: ledger 100 + 88 (worker-advance ledger kept) + inventory 200
    // + raw 100 + table 25 + OTW 50 + customer 70 + supplier overpaid 10 + employee 12 = 655.
    // What We Owe: ledger 50 + 30 + supplier 40 + payroll 20 = 140.
    expect(res.body).toMatchObject({
      asOf: "2026-09-15",
      forUsTotal: 655,
      onUsTotal: 140,
      netPosition: 515,
      supplierLiabilities: 40,
      supplierOverpayments: 10,
      inventoryValue: 200,
      rawMaterialValue: 100,
      balanceOnTableValue: 25,
      pendingTotal: 60,
      verifiedTotal: 70,
      loadingTotal: 80,
      ledgerAssets: 188,
      ledgerLiabilities: 80,
      payrollPayable: 20,
    });
    // Unfinalized orders and the worker-advance table's excess over the ledger
    // (15 − (88 − 50) = −23) are listed apart, never in the totals.
    expect(res.body.notInLedger.lines.map((line: any) => [line.code, line.value])).toEqual([
      ["NOT_IN_LEDGER_FACTORY_INVOICE", 300],
      ["PENDING_ORDERS", 60],
      ["VERIFIED_ORDERS", 70],
      ["LOADING_ORDERS", 80],
      ["WORKER_ADVANCES", -23],
    ]);

    const forUsCodes = res.body.forUs.accounts.map((account: any) => account.code);
    expect(forUsCodes).toEqual(
      expect.arrayContaining([
        "INVENTORY",
        "RAW_MATERIAL",
        "BALANCE_ON_TABLE",
        "STOCK_OTW",
        "CASH",
        "ADV",
        "CUSTOMER_DR",
        "SUPPLIER_OVERPAID",
        "EMPLOYEE_RECEIVABLE",
      ])
    );
    expect(forUsCodes).not.toEqual(
      expect.arrayContaining(["LEGACY_INV", "RENT", "INS", "CUST-6", "PENDING_ORDERS", "WORKER_ADVANCES"])
    );

    const onUsCodes = res.body.onUs.accounts.map((account: any) => account.code);
    expect(onUsCodes).toEqual(expect.arrayContaining(["SUPPLIER", "OTHER", "ADV", "EMPLOYEE_PAYROLL_PAYABLE"]));
    expect(onUsCodes).not.toEqual(expect.arrayContaining(["PAYROLL_PAYABLE", "ACCR-RENT-PAY", "INS"]));

    const supplierArgs = harness.computeNetPositionSupplierBalances.mock.calls[0][0];
    expect(supplierArgs.companyId).toBe(7);
    expect(supplierArgs.asOf).toBe("2026-09-15");
    expect(supplierArgs.contextOnly).toBe(true);
    expect(supplierArgs.getConfigFx("CDF")).toBe(0.00035);
    expect(supplierArgs.getConfigFx("USD")).toBe(1);
    expect(harness.loadNetPositionParties).toHaveBeenCalledWith(
      7,
      expect.objectContaining({ asOf: "2026-09-15", customers: true, factorySuppliers: true, employees: "factory" })
    );
  });

  it("sums ledger movements exactly", async () => {
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push(
      [{ id: 1, name: "Cash", code: "CASH", accountType: "Cash" }],
      [{ id: 9 }],
      [
        { ledgerAccountId: 1, debitAmount: "0.1", creditAmount: "0" },
        { ledgerAccountId: 1, debitAmount: "0.2", creditAmount: "0" },
      ],
      [],
      []
    );
    const res = resHarness();

    await routes.get("GET /api/factory/net-position")!(req(), res);

    expect(res.statusCode).toBe(200);
    // 0.1 + 0.2 reaches the classifier as 0.3, not 0.30000000000000004.
    expect(harness.classifyNetPositionAccounts.mock.calls[0][1].get(1)).toEqual({ debit: 0.3, credit: 0 });
  });

  it("falls back to the client date when asOf is malformed", async () => {
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push([], [], [], [], [], []);
    const res = resHarness();

    await routes.get("GET /api/factory/net-position")!(req({ query: { asOf: "17/09/2026" } }), res);

    expect(res.body.asOf).toBe("2026-09-17");
    expect(harness.getClientDate).toHaveBeenCalledOnce();
  });
});
