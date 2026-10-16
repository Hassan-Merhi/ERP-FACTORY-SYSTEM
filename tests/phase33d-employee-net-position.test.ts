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
    getCustomerLedgerAndMemo: vi.fn(),
    loadHeldChargeSnapshot: vi.fn(),
    loggerError: vi.fn(),
  };
});

// Since #2212 the factory net position takes each customer at the Parties
// page's combined ledger + operational balance, and employees straight from
// employees.currentBalance.
vi.mock("../server/routes/factory/customers-core/customerLedgerSplit", () => ({
  getCustomerLedgerAndMemo: harness.getCustomerLedgerAndMemo,
}));
vi.mock("../server/routes/factory/customers-core/heldUnfinalizedCustomerCharges", () => ({
  loadHeldChargeSnapshot: harness.loadHeldChargeSnapshot,
}));

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

import { MoneyDecimal } from "../server/lib/money";
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
    harness.getCustomerLedgerAndMemo.mockResolvedValue(new Map());
    harness.loadHeldChargeSnapshot.mockResolvedValue({ byCustomer: new Map(), voucherIds: new Set() });
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

  it("keeps Parties customer balances and adds verified and loading orders without pending orders", async () => {
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
    harness.computeNetPositionSupplierBalances.mockResolvedValue({
      supplierLockedRateMapNp: new Map(),
      allContainersF: [],
      supplierItems: [
        { name: "Supplier Due", balanceUsd: 40, breakdown: [] },
        { name: "Supplier Overpaid", balanceUsd: -10, breakdown: [] },
      ],
      totalSupplierLiabilities: 40,
      totalSupplierOverpayments: 10,
    });
    harness.computeNetPositionInventory.mockResolvedValue({
      inventorySellValue: 200,
      rawMaterialStockValue: 100,
      stockOtwValue: 50,
      balanceOnTableValue: 25,
    });
    // Customer 5 owes 50 in the ledger plus 20 not yet in it; customer 6 (whose
    // linked ledger is the classifier's CUST-6) is 30 in credit.
    harness.getCustomerLedgerAndMemo.mockResolvedValue(
      new Map([
        [5, { ledger: new MoneyDecimal(50), memoTotal: new MoneyDecimal(20) }],
        [6, { ledger: new MoneyDecimal(-30), memoTotal: new MoneyDecimal(0) }],
      ])
    );

    harness.executeResults.push(
      { rows: [{ currency_code: "CDF", rate_to_usd: "0.00035" }] },
      { rows: [{ total: "15" }] }
    );
    harness.selectResults.push(
      // ledger accounts, vouchers
      [],
      [],
      // customers
      [
        { id: 5, legalName: "Customer Dr", ledgerAccountId: null },
        { id: 6, legalName: "Customer Cr", ledgerAccountId: 6 },
      ],
      // unfinalized orders
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
      // factory rental units
      [],
      // employees
      [
        { firstName: "Bob", lastName: "Owes", currentBalance: "-12" },
        { firstName: "Pat", lastName: "Due", currentBalance: "20" },
      ]
    );

    const res = resHarness();
    await routes.get("GET /api/factory/net-position")!(req({ query: { asOf: "2026-09-15" } }), res);

    expect(res.statusCode).toBe(200);
    // What We Have: ledger cash 100 + inventory 200 + raw 100 + table 25 + OTW 50
    // + customer 70 + supplier overpaid 10 + employee 12 + worker advances 15
    // + verified orders 70 + loading orders 80 = 732. Pending 60 is not counted.
    // What We Owe: ledger 30 + supplier 40 + customer credit 30 + payroll 20 = 120.
    expect(res.body).toMatchObject({
      asOf: "2026-09-15",
      forUsTotal: 732,
      onUsTotal: 120,
      netPosition: 612,
      supplierLiabilities: 40,
      supplierOverpayments: 10,
      inventoryValue: 200,
      rawMaterialValue: 100,
      balanceOnTableValue: 25,
      pendingTotal: 60,
      verifiedTotal: 70,
      loadingTotal: 80,
      ledgerAssets: 100,
      ledgerLiabilities: 30,
      payrollPayable: 20,
    });

    const forUs = Object.fromEntries(res.body.forUs.accounts.map((account: any) => [account.code, account.value]));
    expect(forUs).toMatchObject({
      INVENTORY: 200,
      RAW_MATERIAL: 100,
      BALANCE_ON_TABLE: 25,
      STOCK_OTW: 50,
      VERIFIED_ORDERS: 70,
      LOADING_ORDERS: 80,
      CASH: 100,
      CUSTOMER_DR: 70,
      SUPPLIER_OVERPAID: 10,
      EMPLOYEE_RECEIVABLE: 12,
      WORKER_ADVANCES: 15,
    });
    // Legacy inventory, the worker-advance and prepaid-rent ledgers, insurance
    // members, the customer's own ledger, and pending orders stay out.
    const forUsCodes = Object.keys(forUs);
    for (const code of ["LEGACY_INV", "ADV", "RENT", "INS", "CUST-6", "PENDING_ORDERS"]) {
      expect(forUsCodes).not.toContain(code);
    }

    const orderLines = res.body.forUs.accounts.filter((a: any) => a.code === "VERIFIED_ORDERS" || a.code === "LOADING_ORDERS");
    expect(orderLines).toEqual([
      expect.objectContaining({ name: "Verified Orders (Not Invoiced)", value: 70, category: "Uninvoiced Orders" }),
      expect.objectContaining({ name: "Loading Orders (In Progress)", value: 80, category: "Uninvoiced Orders" }),
    ]);
    const onUs = Object.fromEntries(res.body.onUs.accounts.map((account: any) => [account.code, account.value]));
    expect(onUs).toMatchObject({ SUPPLIER: 40, OTHER: 30, EMPLOYEE_PAYROLL_PAYABLE: 20, CUSTOMER_CR: 30 });
    for (const code of ["PAYROLL_PAYABLE", "ACCR-RENT-PAY", "ADV", "INS"]) {
      expect(Object.keys(onUs)).not.toContain(code);
    }
    expect(res.body.forUsTotal).toBeCloseTo(
      res.body.forUs.accounts.reduce((sum: number, account: any) => sum + account.value, 0),
      2
    );
    expect(res.body.onUsTotal).toBeCloseTo(
      res.body.onUs.accounts.reduce((sum: number, account: any) => sum + account.value, 0),
      2
    );

    const supplierArgs = harness.computeNetPositionSupplierBalances.mock.calls[0][0];
    expect(supplierArgs.companyId).toBe(7);
    expect(supplierArgs.asOf).toBe("2026-09-15");
    expect(supplierArgs.getConfigFx("CDF")).toBe(0.00035);
    expect(supplierArgs.getConfigFx("USD")).toBe(1);
    // A currency with no confirmed manual rate is refused, never guessed (#2216).
    expect(() => supplierArgs.getConfigFx("EUR")).toThrow("Missing confirmed USD exchange rate for EUR");
    expect(harness.getCustomerLedgerAndMemo).toHaveBeenCalledWith(7, [5, 6], "2026-09-15");
  });

  it("excludes both ledger sides of unfinalized charges before classifying net position", async () => {
    harness.loadHeldChargeSnapshot.mockResolvedValue({
      byCustomer: new Map([[42, new MoneyDecimal(2900)]]),
      voucherIds: new Set([15969]),
    });
    harness.getCustomerLedgerAndMemo.mockResolvedValue(new Map([
      [42, { ledger: new MoneyDecimal(0), memoTotal: new MoneyDecimal(0) }],
    ]));
    harness.executeResults.push({ rows: [] }, { rows: [] });
    harness.selectResults.push(
      [{ id: 1, name: "Customer Ledger", accountType: "Asset" },
       { id: 2, name: "Freight Payable", accountType: "Liability" }],
      [{ id: 15969 }, { id: 15970 }],
      [
        { voucherId: 15969, ledgerAccountId: 1, debitAmount: "2900", creditAmount: "0" },
        { voucherId: 15969, ledgerAccountId: 2, debitAmount: "0", creditAmount: "2900" },
        { voucherId: 15970, ledgerAccountId: 2, debitAmount: "0", creditAmount: "100" },
      ],
      [{ id: 42, legalName: "ANGOLA", ledgerAccountId: 1 }],
      [],
      []
    );
    const res = resHarness();
    await routes.get("GET /api/factory/net-position")!(req(), res);
    expect(res.statusCode).toBe(200);
    const balances = harness.classifyNetPositionAccounts.mock.calls[0][1];
    expect(balances.get(1)).toBeUndefined();
    expect(balances.get(2)).toEqual({ debit: 0, credit: 100 });
    expect(res.body.forUs.accounts.some((row: any) => row.name === "ANGOLA")).toBe(false);
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
