import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const selectResults: unknown[][] = [];
  const poolResults: unknown[][] = [];
  const workbooks: FakeWorkbook[] = [];

  class FakeCell {
    value: any = null;
    font: any;
    fill: any;
    alignment: any;
    numFmt: any;
  }
  class FakeRow {
    number: number;
    height: any;
    cells = new Map<any, FakeCell>();
    constructor(number: number, values?: any) {
      this.number = number;
      if (Array.isArray(values)) values.forEach((value, i) => (this.getCell(i + 1).value = value));
      else if (values && typeof values === "object")
        Object.entries(values).forEach(([key, value]) => (this.getCell(key).value = value));
    }
    getCell(key: any) {
      if (!this.cells.has(key)) this.cells.set(key, new FakeCell());
      return this.cells.get(key)!;
    }
    eachCell(callback: (cell: FakeCell) => void) {
      if (this.cells.size === 0) this.getCell(1);
      this.cells.forEach(callback);
    }
  }
  class FakeWorksheet {
    name: string;
    rows: FakeRow[] = [];
    columns: any;
    constructor(name: string) {
      this.name = name;
    }
    addRow(values: any) {
      const row = new FakeRow(this.rows.length + 1, values);
      this.rows.push(row);
      return row;
    }
    getRow(number: number) {
      while (this.rows.length < number) this.rows.push(new FakeRow(this.rows.length + 1));
      return this.rows[number - 1];
    }
    spliceRows(start: number, deleteCount: number, ...insert: any[]) {
      const replacementRows = insert.map((values, index) => new FakeRow(start + index, values));
      this.rows.splice(start - 1, deleteCount, ...replacementRows);
      this.rows.forEach((row, index) => {
        row.number = index + 1;
      });
    }
    mergeCells() {}
  }
  class FakeWorkbook {
    creator: any;
    created: any;
    sheets: FakeWorksheet[] = [];
    xlsx = { writeBuffer: vi.fn(async () => Buffer.from("net-position-xlsx")) };
    constructor() {
      workbooks.push(this);
    }
    addWorksheet(name: string) {
      const sheet = new FakeWorksheet(name);
      this.sheets.push(sheet);
      return sheet;
    }
  }

  const makeBuilder = (result: unknown[]) => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      execute: vi.fn(async () => result),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(result).then(resolve, reject),
    };
    return builder;
  };

  return {
    db: { select: vi.fn(() => makeBuilder(selectResults.shift() ?? [])) },
    pool: { query: vi.fn(async () => ({ rows: poolResults.shift() ?? [] })) },
    selectResults,
    poolResults,
    workbooks,
    FakeWorkbook,
    storage: {
      getAllCompanies: vi.fn(),
      getAllLedgerAccounts: vi.fn(),
      getParentCompanyId: vi.fn(),
    },
    classifyNetPositionAccounts: vi.fn(),
    classifyEquityAccounts: vi.fn(),
    calculateHistoricalLocationInventory: vi.fn(),
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
  logAudit: harness.logAudit,
  calculateHistoricalLocationInventory: harness.calculateHistoricalLocationInventory,
}));
vi.mock("../server/lib/dateUtils", () => ({ getClientDate: () => "2026-08-12" }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { error: vi.fn() } }));
vi.mock("../server/netPositionHelper", () => ({
  classifyNetPositionAccounts: harness.classifyNetPositionAccounts,
  classifyEquityAccounts: harness.classifyEquityAccounts,
  round2: (value: number) => Math.round((value + Number.EPSILON) * 100) / 100,
}));
vi.mock("exceljs", () => ({ default: { Workbook: harness.FakeWorkbook } }));
vi.mock("drizzle-orm", () => ({
  eq: (column: unknown, value: unknown) => ({ type: "eq", column, value }),
  and: (...conditions: unknown[]) => ({ type: "and", conditions }),
  or: (...conditions: unknown[]) => ({ type: "or", conditions }),
  inArray: (column: unknown, values: unknown[]) => ({ type: "inArray", column, values }),
  isNull: (column: unknown) => ({ type: "isNull", column }),
  lte: (column: unknown, value: unknown) => ({ type: "lte", column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  inventory: {
    locationId: "inventory.locationId",
    quantity: "inventory.quantity",
    averageRate: "inventory.averageRate",
  },
  containers: {
    companyId: "containers.companyId",
    importDate: "containers.importDate",
    status: "containers.status",
    offloadDate: "containers.offloadDate",
  },
  vouchers: {
    companyId: "vouchers.companyId",
    optional: "vouchers.optional",
    deletedAt: "vouchers.deletedAt",
    voucherDate: "vouchers.date",
  },
  suppliers: { id: "suppliers.id", deletedAt: "suppliers.deletedAt" },
  locations: {
    id: "locations.id",
    companyId: "locations.companyId",
    active: "locations.active",
    deletedAt: "locations.deletedAt",
  },
  factoryWorkerAdvances: { companyId: "adv.companyId", fullyPaid: "adv.fullyPaid" },
}));

import { registerStatsNetPositionRoutes } from "../server/routes/stats/statsNetPositionRoutes";

type Handler = (req: any, res: any) => unknown;

function route() {
  let handler: Handler | undefined;
  const app: any = {
    get: (path: string, ...handlers: any[]) => path === "/api/stats/net-position-excel" && (handler = handlers.at(-1)),
  };
  registerStatsNetPositionRoutes(app);
  return handler!;
}

function responseHarness() {
  const headers = new Map<string, unknown>();
  const res: any = {
    statusCode: 200,
    body: undefined,
    headersSent: false,
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

describe("net position Excel behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.selectResults.splice(0);
    harness.poolResults.splice(0);
    harness.workbooks.splice(0);
    harness.storage.getAllCompanies.mockResolvedValue([{ id: 4, name: "GC Lshi", companyType: "erp" }]);
    harness.storage.getAllLedgerAccounts.mockResolvedValue([
      { id: 1, name: "Cash", code: "CASH", accountType: "Cash", openingBalance: "0" },
      { id: 2, name: "Factory Worker Advances", code: "FWA", accountType: "Asset", openingBalance: "0" },
    ]);
    harness.storage.getParentCompanyId.mockResolvedValue(4);
    harness.classifyNetPositionAccounts.mockReturnValue({
      forUsTotal: 100,
      onUsTotal: 50,
      forUsAccounts: [
        { name: "Cash", code: "CASH", value: 100, category: "Cash" },
        { name: "Factory Worker Advances", code: "FWA", value: 20, category: "Asset" },
      ],
      onUsAccounts: [{ name: "Loan", code: "LOAN", value: 50, category: "Liability" }],
    });
    // Only supplier-partner exports fold equity into the position; this fixture is an ERP company,
    // so the stub stays empty and the totals below are unaffected by it.
    harness.classifyEquityAccounts.mockReturnValue({ total: 0, accounts: [] });
  });

  it("builds the consolidated net position from accounts, stock, worker advances, suppliers, and OTW stock", async () => {
    harness.poolResults.push(
      [{ ledger_account_id: "1", supplier_id: "7", debit_amount: "10", credit_amount: "40" }],
      [{ ledger_account_id: "1", debit_amount: "120", credit_amount: "20" }]
    );
    harness.selectResults.push(
      [{ id: 11 }],
      [
        { quantity: "5", averageRate: "4" },
        { quantity: "2", averageRate: "10" },
      ],
      [{ total: "15" }],
      [{ id: 7, legalName: "Supplier A", code: "SUP-A", openingBalance: "10" }],
      [{ id: 90, grandTotal: "25", itemsTotal: "20", status: "OTW" }]
    );

    const res = responseHarness();
    await route()({ session: { currentCompanyId: 4, userId: "admin-1", username: "admin" }, query: {} }, res);

    expect(harness.classifyNetPositionAccounts).toHaveBeenCalled();
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 4, action: "export", tableName: "reports" })
    );
    expect(res.headers.get("Content-Type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(res.body).toEqual(Buffer.from("net-position-xlsx"));

    const summary = harness.workbooks[0].sheets.find((sheet) => sheet.name === "Net Position Summary");
    const text = summary?.rows.flatMap((row) => [...row.cells.values()].map((cell) => cell.value)).join(" | ") ?? "";
    expect(text).toContain("What We Have");
    expect(text).toContain("What We Owe");
    expect(text).toContain("Net Position");
  });

  it("uses historical inventory snapshots for an as-of export date", async () => {
    harness.poolResults.push([], []);
    harness.selectResults.push([{ id: 11 }], [{ total: "0" }], []);
    harness.calculateHistoricalLocationInventory.mockResolvedValue([
      { quantity: "3", averageRate: "7" },
      { quantity: "1", averageRate: "9" },
    ]);

    const res = responseHarness();
    await route()({ session: { currentCompanyId: 4, userId: "admin-1" }, query: { toDate: "2026-07-31" } }, res);

    expect(harness.calculateHistoricalLocationInventory).toHaveBeenCalledWith(11, 4, "2026-07-31");
    expect(res.body).toEqual(Buffer.from("net-position-xlsx"));
  });

  it("sums account and supplier balances exactly before classifying", async () => {
    harness.poolResults.push(
      [
        { ledger_account_id: "1", supplier_id: "7", debit_amount: "0.1", credit_amount: "0" },
        { ledger_account_id: "1", supplier_id: "7", debit_amount: "0.2", credit_amount: "0" },
      ],
      [
        { ledger_account_id: "1", debit_amount: "0.1", credit_amount: "0" },
        { ledger_account_id: "1", debit_amount: "0.2", credit_amount: "0" },
      ]
    );
    harness.selectResults.push(
      [{ id: 11 }],
      [{ quantity: "1.3", averageRate: "0.35" }],
      [{ total: "0" }],
      [{ id: 7, legalName: "Supplier A", code: "SUP-A", openingBalance: "0" }],
      []
    );

    const res = responseHarness();
    await route()({ session: { currentCompanyId: 4, userId: "admin-1" }, query: {} }, res);

    const balances = harness.classifyNetPositionAccounts.mock.calls[0][1] as Map<number, unknown>;
    expect(balances.get(1)).toEqual({ debit: 0.3, credit: 0 });
    const assets = harness.workbooks[0].sheets.find((sheet) => sheet.name.includes("Assets"));
    const values = assets?.rows.map((row) => row.getCell("value").value) ?? [];
    expect(values).toContain(0.3);
    expect(values).toContain(0.46);
  });

  it("rejects exports when no company is selected", async () => {
    const res = responseHarness();
    await route()({ session: {}, query: {} }, res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ message: "No company selected" });
  });
});
