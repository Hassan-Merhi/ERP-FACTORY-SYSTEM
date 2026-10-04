import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => unknown>(),
  queryResults: [] as unknown[][],
  poolQuery: vi.fn(),
  buildPaginationIntegrityConditions: vi.fn(() => ["source integrity condition"]),
}));

vi.mock("../server/auth", () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock("../server/db", () => ({
  db: {
    select: () => {
      const result = harness.queryResults.shift() ?? [];
      return { from: () => ({ where: async () => result }) };
    },
  },
  pool: { query: harness.poolQuery },
}));
vi.mock("../server/services/factory/daybookSourceIntegrity", () => ({
  buildPaginationIntegrityConditions: harness.buildPaginationIntegrityConditions,
}));
vi.mock("@shared/schema", () => ({
  factoryUserProfiles: {
    companyId: "factoryUserProfiles.companyId",
    userId: "factoryUserProfiles.userId",
    hiddenCostFields: "factoryUserProfiles.hiddenCostFields",
  },
  factoryBales: { id: "factoryBales.id", productId: "factoryBales.productId", articleCode: "factoryBales.articleCode" },
  factoryBaleProducts: {
    id: "factoryBaleProducts.id",
    articleCode: "factoryBaleProducts.articleCode",
    productionPrice: "factoryBaleProducts.productionPrice",
    companyId: "factoryBaleProducts.companyId",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  inArray: (column: unknown, values: unknown[]) => ({ column, values }),
  or: (...conditions: unknown[]) => conditions,
}));

import { registerFactoryDaybookPaginationRoutes } from "../server/routes/factory/factoryDaybookPaginationRoutes";

describe("factory Daybook pagination route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.handlers.clear();
    harness.queryResults.splice(0);
    harness.queryResults.push(
      [{ hiddenCostFields: ["daybook_own_only"] }],
      [
        { id: 501, productId: 71, articleCode: "A-71" },
        { id: 502, productId: null, articleCode: "A-72" },
      ],
      [
        { id: 71, articleCode: "A-71", productionPrice: "25" },
        { id: 72, articleCode: "A-72", productionPrice: "15" },
      ]
    );
    harness.poolQuery.mockResolvedValue({
      rows: [
        {
          total: 301,
          items: [
            {
              id: 1,
              txType: "BALE_STOCK_ENTRY",
              metaJson: JSON.stringify({ bales: [{ id: 501 }, { id: 502 }] }),
              amountCurrency: "0",
              amountUsd: "0",
            },
            { id: 2, txType: "JOURNAL", metaJson: null, amountCurrency: "20", amountUsd: "20" },
          ],
        },
      ],
    });
    registerFactoryDaybookPaginationRoutes({
      get: (path: string, ...callbacks: Array<(...args: any[]) => unknown>) => {
        harness.handlers.set(path, callbacks.at(-1)!);
      },
    } as never);
  });

  it("returns an own-only filtered page and derives bale-stock value from current product prices", async () => {
    const req = {
      session: { factoryCompanyId: 4, userId: 7, currentRole: "Admin" },
      query: {
        pagination: "1",
        startDate: "2026-08-01",
        endDate: "2026-08-11",
        txType: "BALE_STOCK_ENTRY",
        currencyCode: "USD",
        search: "press",
        optionalStatus: "exclude",
        minAmount: "10",
        maxAmount: "500",
        page: "2",
        limit: "250",
        sortOrder: "asc",
      },
    };
    const res = { status: vi.fn(), json: vi.fn(), setHeader: vi.fn() };
    const next = vi.fn();
    res.status.mockReturnValue(res);

    await harness.handlers.get("/api/factory/daybook")!(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        total: 301,
        page: 2,
        limit: 250,
        totalPages: 2,
        hasNextPage: false,
        hasPreviousPage: true,
        items: [
          expect.objectContaining({ id: 1, amountCurrency: "40.00", amountUsd: "40.00" }),
          expect.objectContaining({ id: 2, amountCurrency: "20" }),
        ],
      })
    );
    const [query, values] = harness.poolQuery.mock.calls[0];
    expect(query).toContain("source integrity condition");
    expect(query).toContain("f.created_by =");
    expect(query).toContain("LEFT JOIN factory_raw_stock offload_raw_stock");
    expect(query).toContain("LEFT JOIN factory_containers offload_container");
    expect(query).toContain("LEFT JOIN factory_suppliers offload_supplier");
    expect(query).toContain("' - ' || BTRIM(offload_supplier.name)");
    expect(query).toContain("optional = false");
    expect(query).toContain("ORDER BY sort_date ASC");
    expect(values).toEqual(
      expect.arrayContaining([
        4,
        "2026-08-01",
        "2026-08-11",
        "BALE_STOCK_ENTRY",
        "USD",
        "7",
        false,
        "%press%",
        10,
        500,
        250,
        250,
      ])
    );
  });

  it("delegates the legacy non-paginated request to the next registered handler", async () => {
    const next = vi.fn();

    await harness.handlers.get("/api/factory/daybook")!({ query: {}, session: {} }, {}, next);

    expect(next).toHaveBeenCalledOnce();
    expect(harness.poolQuery).not.toHaveBeenCalled();
  });
});
