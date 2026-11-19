import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const makeBuilder = () => {
    const builder: any = {
      from: vi.fn(() => builder),
      where: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve([]).then(resolve, reject),
    };
    return builder;
  };

  return {
    db: {
      select: vi.fn(() => makeBuilder()),
      execute: vi.fn(async () => ({ rows: [] })),
    },
    calculateHistoricalLocationInventory: vi.fn(),
    fetchStockMovements: vi.fn(),
    requireSpCompany: vi.fn(),
    generateV1: vi.fn(),
    generateV2: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("../server/routes/helpers/inventoryHistoryHelpers", () => ({
  calculateHistoricalLocationInventory: harness.calculateHistoricalLocationInventory,
}));
vi.mock("../server/routes/inventory-movement/_helpers", () => ({
  MONTH_NAMES_INV: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  dayBefore: (value: string) => value,
  fetchStockMovements: harness.fetchStockMovements,
}));
vi.mock("../server/routes/sp/spHelpers", () => ({ requireSpCompany: harness.requireSpCompany }));
vi.mock("../server/services/sp-sales-form", () => ({ generateSpSalesFormExcel: harness.generateV1 }));
vi.mock("../server/services/spSalesFormExportV2", () => ({ generateSpSalesFormExcelV2: harness.generateV2 }));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  companies: { id: "companies.id", name: "companies.name" },
  ledgerAccounts: { id: "accounts.id", companyId: "accounts.companyId" },
  locations: { id: "locations.id", companyId: "locations.companyId", name: "locations.name" },
  stockItems: { id: "stock.id", openingQty: "stock.openingQty", openingRate: "stock.openingRate" },
}));

import { registerInventoryMovementReportRoutes } from "../server/routes/inventory-movement/movement";
import { registerSpExportRoutes } from "../server/routes/sp/spExportRoutes";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: Handler[]) => routes.set(`GET ${path}`, handlers.at(-1)!),
  };
  registerInventoryMovementReportRoutes(app);
  registerSpExportRoutes(app);
  return routes;
}

function request(query: Record<string, unknown>) {
  return { session: { currentCompanyId: 4 }, params: {}, query } as any;
}

function responseHarness() {
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
    setHeader: vi.fn(),
    send: vi.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res;
}

describe("CodeQL Phase 2 query boundaries", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.clearAllMocks();
    harness.requireSpCompany.mockResolvedValue(4);
    harness.generateV1.mockResolvedValue(Buffer.from("v1"));
    harness.generateV2.mockResolvedValue(Buffer.from("v2"));
  });

  it("rejects repeated inventory movement identifiers", async () => {
    const summary = responseHarness();
    await routes.get("GET /api/inventory/movement")!(request({ stockItemId: ["1", "2"] }), summary);
    expect(summary.statusCode).toBe(400);
    expect(harness.fetchStockMovements).not.toHaveBeenCalled();

    const drill = responseHarness();
    await routes.get("GET /api/inventory/movement/drill")!(
      request({ stockItemId: "1", year: ["2026", "2027"], month: "8" }),
      drill
    );
    expect(drill.statusCode).toBe(400);
    expect(harness.fetchStockMovements).not.toHaveBeenCalled();
  });

  it("rejects repeated SP export dates and identifiers", async () => {
    const v1 = responseHarness();
    await routes.get("GET /api/sp/sales-form/export")!(
      request({ fromDate: ["2026-08-01", "2026-08-02"], toDate: "2026-08-28" }),
      v1
    );
    expect(v1.statusCode).toBe(400);
    expect(harness.generateV1).not.toHaveBeenCalled();

    const v2 = responseHarness();
    await routes.get("GET /api/sp/sales-form/export-v2")!(
      request({ fromDate: "2026-08-01", toDate: "2026-08-28", cashAccountId: ["5", "6"] }),
      v2
    );
    expect(v2.statusCode).toBe(400);
    expect(harness.generateV2).not.toHaveBeenCalled();
  });

  it("rejects malformed scalar values before database work", async () => {
    const movement = responseHarness();
    await routes.get("GET /api/inventory/movement")!(request({ stockItemId: "not-a-number" }), movement);
    expect(movement.statusCode).toBe(400);
    expect(harness.db.select).not.toHaveBeenCalled();

    const sp = responseHarness();
    await routes.get("GET /api/sp/sales-form/export-v2")!(
      request({ fromDate: "2026-08-28", toDate: "2026-08-01" }),
      sp
    );
    expect(sp.statusCode).toBe(400);
    expect(harness.generateV2).not.toHaveBeenCalled();
  });
});
