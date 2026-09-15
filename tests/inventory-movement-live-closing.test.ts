import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    selectRows: [] as unknown[],
  };

  const makeBuilder = () => {
    const builder: any = {
      from: vi.fn(() => builder),
      innerJoin: vi.fn(() => builder),
      where: vi.fn(() => builder),
      then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
        Promise.resolve(state.selectRows).then(resolve, reject),
    };
    return builder;
  };

  return {
    state,
    db: {
      select: vi.fn(() => makeBuilder()),
    },
    calculateHistoricalLocationInventory: vi.fn(),
    fetchStockMovements: vi.fn(),
  };
});

vi.mock("../server/db", () => ({ db: harness.db }));
vi.mock("../server/auth", () => ({ requireAuth: (_req: any, _res: any, next: any) => next() }));
vi.mock("../server/lib/httpHandlers", () => ({ getErrorMessage: (error: any) => error?.message || String(error) }));
vi.mock("../server/routes/helpers/inventoryHistoryHelpers", () => ({
  calculateHistoricalLocationInventory: harness.calculateHistoricalLocationInventory,
}));
vi.mock("../server/routes/inventory-movement/_helpers", () => ({
  MONTH_NAMES_INV: [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ],
  dayBefore: (value: string) => value,
  fetchStockMovements: harness.fetchStockMovements,
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => ({ conditions }),
  eq: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ column, op: "isNull" }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));
vi.mock("@shared/schema", () => ({
  inventory: {
    quantity: "inventory.quantity",
    totalValue: "inventory.totalValue",
    locationId: "inventory.locationId",
    companyId: "inventory.companyId",
    stockItemId: "inventory.stockItemId",
  },
  locations: {
    id: "locations.id",
    deletedAt: "locations.deletedAt",
  },
}));

import { registerInventoryMovementReportRoutes } from "../server/routes/inventory-movement/movement";

type Handler = (req: any, res: any) => unknown;

function buildRoutes() {
  const routes = new Map<string, Handler>();
  const app: any = {
    get: (path: string, ...handlers: Handler[]) => routes.set(`GET ${path}`, handlers.at(-1)!),
  };
  registerInventoryMovementReportRoutes(app);
  return routes;
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
  };
  return res;
}

describe("inventory movement All Locations closing balance", () => {
  const routes = buildRoutes();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T12:00:00.000Z"));
    vi.clearAllMocks();
    harness.state.selectRows = [{ quantity: "2476", totalValue: "37140" }];
    harness.fetchStockMovements.mockResolvedValue([
      {
        date: "2026-09-05",
        particulars: "Receipt",
        vchType: "Purchase Import",
        voucherId: 1,
        poId: 1,
        inwardQty: 319,
        inwardRate: 15,
        inwardValue: 4785,
        outwardQty: 0,
        outwardRate: 0,
        outwardValue: 0,
        isPOS: false,
        posSellingRate: 0,
        posSellingValue: 0,
      },
      {
        date: "2026-09-10",
        particulars: "Main Store",
        vchType: "Sales",
        voucherId: 2,
        poId: null,
        inwardQty: 0,
        inwardRate: 0,
        inwardValue: 0,
        outwardQty: 270,
        outwardRate: 59.74,
        outwardValue: 16129.8,
        isPOS: false,
        posSellingRate: 60,
        posSellingValue: 16200,
      },
    ]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses summed live inventory quantity and value as the authoritative company-wide close", async () => {
    const res = responseHarness();
    await routes.get("GET /api/inventory/movement")!(
      {
        session: { currentCompanyId: 4 },
        query: { stockItemId: "9", startDate: "2026-09-01", endDate: "2026-09-14" },
      },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body.months).toHaveLength(1);
    expect(res.body.months[0]).toMatchObject({
      closingQty: 2476,
      closingValue: 37140,
      closingRate: 15,
    });
    expect(res.body.grandTotal).toMatchObject({
      closingQty: 2476,
      closingValue: 37140,
    });
    expect(harness.state.selectRows).toEqual([{ quantity: "2476", totalValue: "37140" }]);
  });
});
