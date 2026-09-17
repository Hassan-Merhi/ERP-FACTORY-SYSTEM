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
    loggerError: vi.fn(),
  };
});

vi.mock("../server/db", () => ({
  db: harness.db,
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: harness.getClientDate }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: harness.loggerError } }));
vi.mock("../server/netPositionHelper", () => ({ classifyNetPositionAccounts: harness.classifyNetPositionAccounts }));
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
    expect(res.body.onUs.accounts).toEqual([
      expect.objectContaining({ code: "EMPLOYEE_PAYROLL_PAYABLE", value: 0 }),
    ]);
  });

  it("uses authoritative factory sources, strips duplicate ledger categories, and separates employee payables from receivables", async () => {
    harness.classifyNetPositionAccounts.mockReturnValue({
      forUsAccounts: [
        { id: 1, name: "Operating Cash", code: "CASH", category: "Asset", value: 100 },
        { id: 2, name: "Legacy Inventory", code: "LEGACY_INV", category: "Inventory", value: 999 },
        { id: 3, name: "Factory Worker Advances", code: "ADV", category: "Asset", value: 88 },
        { id: 4, name: "Prepaid Rent - Legacy", code: "RENT", category: "Asset", value: 50 },
        { id: 5, name: "Insurance - Member", code: "INS", category: "Asset", value: 20 },
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

    harness.executeResults.push(
      { rows: [{ currency_code: "CDF", rate_to_usd: "0.00035" }] },
      { rows: [{ total: "15" }] }
    );
    harness.selectResults.push(
      [],
      [],
      [],
      [
        { id: 1, status: "PENDING_VERIFICATION", orderDate: "2026-09-10", grandTotal: "60", totalQtyBales: 1, customerId: 1, customerName: "Pending Customer" },
        { id: 2, status: "VERIFIED", orderDate: "2026-09-11", grandTotal: "70", totalQtyBales: 2, customerId: 2, customerName: "Verified Customer" },
        { id: 3, status: "LOADING", orderDate: "2026-09-12", grandTotal: "80", totalQtyBales: 3, customerId: 3, customerName: "Loading Customer" },
      ],
      [],
      [
        { firstName: "Alice", lastName: "Pay", currentBalance: "20" },
        { firstName: "Bob", lastName: "Owes", currentBalance: "-12" },
        { firstName: "Zero", lastName: "Balance", currentBalance: "0" },
      ]
    );

    const res = resHarness();
    await routes.get("GET /api/factory/net-position")!(req({ query: { asOf: "2026-09-15" } }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      asOf: "2026-09-15",
      forUsTotal: 722,
      onUsTotal: 90,
      netPosition: 632,
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

    const forUsCodes = res.body.forUs.accounts.map((account: any) => account.code);
    expect(forUsCodes).toEqual(expect.arrayContaining([
      "INVENTORY",
      "RAW_MATERIAL",
      "BALANCE_ON_TABLE",
      "STOCK_OTW",
      "CASH",
      "SUPPLIER_OVERPAID",
      "PENDING_ORDERS",
      "VERIFIED_ORDERS",
      "LOADING_ORDERS",
      "EMPLOYEE_RECEIVABLE",
      "WORKER_ADVANCES",
    ]));
    expect(forUsCodes).not.toEqual(expect.arrayContaining(["LEGACY_INV", "ADV", "RENT", "INS"]));

    const onUsCodes = res.body.onUs.accounts.map((account: any) => account.code);
    expect(onUsCodes).toEqual(expect.arrayContaining(["SUPPLIER", "OTHER", "EMPLOYEE_PAYROLL_PAYABLE"]));
    expect(onUsCodes).not.toEqual(expect.arrayContaining(["PAYROLL_PAYABLE", "ACCR-RENT-PAY", "ADV", "INS"]));

    const supplierArgs = harness.computeNetPositionSupplierBalances.mock.calls[0][0];
    expect(supplierArgs.companyId).toBe(7);
    expect(supplierArgs.asOf).toBe("2026-09-15");
    expect(supplierArgs.getConfigFx("CDF")).toBe(0.00035);
    expect(supplierArgs.getConfigFx("USD")).toBe(1);
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