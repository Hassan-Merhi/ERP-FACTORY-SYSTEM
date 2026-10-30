/**
 * The Phase 1 forecast's scoring bands, one item at a time: demand trend,
 * stockout urgency, sell-through, source availability and reserve, OTW
 * reliability by match type and ETA, assortment and data quality, plus the
 * historical need floor. The base preview and database reads are stubbed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const queryResults: unknown[][] = [];
  const buildSmartTransferPreview = vi.fn();
  const loadOtwStockByItem = vi.fn();
  const select = vi.fn(() => {
    const result = queryResults.shift() ?? [];
    const builder: { innerJoin: () => typeof builder; where: () => Promise<unknown[]> } = {
      innerJoin: () => builder,
      where: async () => result,
    };
    return { from: () => builder };
  });
  return { queryResults, buildSmartTransferPreview, loadOtwStockByItem, select };
});

vi.mock("../server/db", () => ({ db: { select: harness.select } }));
vi.mock("@shared/schema", () => ({
  inventory: {
    stockItemId: "inventory.stockItemId",
    locationId: "inventory.locationId",
    quantity: "inventory.quantity",
    averageRate: "inventory.averageRate",
    companyId: "inventory.companyId",
  },
  salesItems: {
    stockItemId: "salesItems.stockItemId",
    voucherId: "salesItems.voucherId",
    quantity: "salesItems.quantity",
  },
  vouchers: {
    id: "vouchers.id",
    voucherDate: "vouchers.voucherDate",
    companyId: "vouchers.companyId",
    voucherType: "vouchers.voucherType",
    optional: "vouchers.optional",
    deletedAt: "vouchers.deletedAt",
    locationId: "vouchers.locationId",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...conditions: unknown[]) => conditions,
  eq: (column: unknown, value: unknown) => ({ column, value }),
  gte: (column: unknown, value: unknown) => ({ column, value }),
  inArray: (column: unknown, value: unknown) => ({ column, value }),
  isNull: (column: unknown) => ({ column, value: null }),
  lte: (column: unknown, value: unknown) => ({ column, value }),
}));
vi.mock("../server/services/smartTransferAllocation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../server/services/smartTransferAllocation")>();
  return { ...actual, buildSmartTransferPreview: harness.buildSmartTransferPreview };
});
vi.mock("../server/services/stockTransferAnalysis", () => ({
  loadOtwStockByItem: harness.loadOtwStockByItem,
}));

import { buildSmartTransferForecastPreview } from "../server/services/smartTransferForecasting";

function previewLine(overrides: Record<string, unknown>) {
  return {
    stockItemId: 1,
    stockItemName: "Blue Widget",
    stockItemCode: "BLUE",
    uom: "pcs",
    stockGroupId: 201,
    categoryId: 101,
    sourceLocationId: 11,
    sourceLocationName: "North Warehouse",
    availableAtSource: 30,
    sourceCurrentStock: 30,
    sourceReserveQty: 0,
    sourceAverageRate: 12.5,
    destinationStock: 2,
    otwQty: 0,
    effectiveDestinationStock: 2,
    olderTransferQty: 20,
    newerTransferQty: 15,
    salesAfterOlderTransfer: 18,
    salesAfterNewerTransfer: 14,
    totalSalesSinceOlderTransfer: 32,
    olderSellThroughPercentage: 90,
    newerSellThroughPercentage: 93,
    overallSellThroughPercentage: 92,
    averageSalesPerDay: 1.2,
    latestSalesPerDay: 1.8,
    estimatedDaysOfStockRemaining: 2,
    classification: "strong_seller",
    classificationLabel: "Strong seller",
    suggestedQuantity: 15,
    itemSuggestedTotal: 15,
    calculatedNeed: 20,
    confidence: 0.8,
    reason: "Historical demand.",
    ...overrides,
  };
}

function basePreview(lines: unknown[]) {
  return {
    readOnly: true,
    generatedAt: "2026-08-11T00:00:00.000Z",
    companyId: 4,
    destinationLocationId: 23,
    destinationLocationName: "Riverside Shop",
    sourceLocationIds: [11, 12],
    sourceLocationNames: ["North Warehouse", "South Warehouse"],
    targetQuantity: 45,
    achievedQuantity: 45,
    shortfallQuantity: 0,
    shortfall: false,
    includeOtw: true,
    targetCoverageDays: 30,
    stockGroupIds: [],
    categoryIds: [],
    lines,
    excludedItems: [],
    totalsBySource: [],
    history: {},
    warnings: ["Existing preview is short by 1 suitable calculated demand"],
    summary: "Historical preview complete.",
  };
}

type Sale = [string, number];
const d7 = "2026-08-10";
const d30 = "2026-07-20";
const d90 = "2026-06-01";
const STABLE: Sale[] = [
  [d7, 7],
  [d30, 23],
];
const NO_HISTORY = { latestSalesPerDay: 0, averageSalesPerDay: 0 };

async function forecast(
  over: Record<string, unknown>,
  sales: Sale[],
  opts: { stock?: number; sourceSales?: number; otw?: unknown[]; target?: number } = {}
) {
  harness.queryResults.splice(0);
  harness.buildSmartTransferPreview.mockResolvedValue(basePreview([previewLine(over)]));
  harness.queryResults.push(
    sales.map(([voucherDate, quantity]) => ({ stockItemId: 1, voucherDate, quantity: String(quantity) })),
    [{ stockItemId: 1, locationId: 11, quantity: String(opts.stock ?? 100), averageRate: "10" }],
    opts.sourceSales ? [{ stockItemId: 1, locationId: 11, quantity: String(opts.sourceSales) }] : []
  );
  harness.loadOtwStockByItem.mockResolvedValue({
    otwQtyByItem: new Map(),
    otwDetailsByItem: new Map([[1, opts.otw ?? []]]),
  });
  return buildSmartTransferForecastPreview(4, [11], 23, opts.target ?? 0, { asOfDate: "2026-08-11" });
}
async function line(...args: Parameters<typeof forecast>) {
  const result = await forecast(...args);
  expect(result.lines).toHaveLength(1);
  return result.lines[0];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("forecast demand trend", () => {
  it("classifies acceleration by the recent-to-prior sales ratio", async () => {
    const cases: Array<[Sale[], string, number | null, number, number]> = [
      [
        [
          [d7, 14],
          [d30, 23],
        ],
        "accelerating",
        2,
        10,
        1.298,
      ],
      [
        [
          [d7, 10.5],
          [d30, 23],
        ],
        "accelerating",
        1.5,
        9,
        1.047,
      ],
      [
        [
          [d7, 9.1],
          [d30, 23],
        ],
        "accelerating",
        1.3,
        8,
        0.946,
      ],
      [[[d7, 3]], "accelerating", null, 8, 0.106],
      [
        [
          [d7, 8.75],
          [d30, 23],
        ],
        "accelerating",
        1.25,
        8,
        0.921,
      ],
      [STABLE, "stable", 1, 5, 0.737],
      [
        [
          [d7, 3.5],
          [d30, 23],
        ],
        "declining",
        0.5,
        1,
        0.464,
      ],
    ];
    for (const [sales, trend, ratio, score, rate] of cases) {
      const result = await line(NO_HISTORY, sales);
      expect([
        result.forecastTrend,
        result.forecastTrendRatio,
        result.scoreBreakdown.salesAcceleration,
        result.forecastDailyRate,
      ]).toEqual([trend, ratio, score, rate]);
    }
    const thin = await line({ ...NO_HISTORY, destinationStock: 0 }, [[d7, 2]]);
    expect([thin.forecastTrend, thin.forecastTrendRatio, thin.scoreBreakdown.salesAcceleration]).toEqual([
      "insufficient_data",
      null,
      3,
    ]);
  });

  it("shifts weight to longer windows when recent sales are thin", async () => {
    expect(
      (
        await line(NO_HISTORY, [
          [d7, 2.5],
          [d30, 23],
        ])
      ).forecastDailyRate
    ).toBe(0.435);
  });

  it("blends in the historical daily rate when the window rate is present", async () => {
    expect((await line({ latestSalesPerDay: 0, averageSalesPerDay: 2 }, STABLE)).forecastDailyRate).toBe(1.037);
    expect((await line({ latestSalesPerDay: 1.8, averageSalesPerDay: 2 }, STABLE)).forecastDailyRate).toBe(1.007);
  });
});

describe("forecast score bands", () => {
  it("scores stockout urgency by days of destination stock left", async () => {
    for (const [destinationStock, days, score] of [
      [2, 2.7, 25],
      [5, 6.8, 22],
      [10, 13.6, 18],
      [15, 20.4, 13],
      [20, 27.1, 8],
    ]) {
      const result = await line({ ...NO_HISTORY, destinationStock }, STABLE);
      expect([result.daysUntilStockout, result.scoreBreakdown.stockoutUrgency]).toEqual([days, score]);
    }
  });

  it("keeps a historically strong item without current sales on the history floor", async () => {
    const result = await line({ ...NO_HISTORY, calculatedNeed: 20 }, []);
    expect(result).toMatchObject({
      forecastDailyRate: 0,
      daysUntilStockout: null,
      calculatedNeed: 15,
      itemScore: 42,
      urgencyBand: "low",
      scoreBreakdown: { stockoutUrgency: 0, forecastDemand: 0, dataQuality: 1 },
    });
    expect(result.reason).toContain("stockout timing unavailable; no destination OTW recorded");
  });

  it("lowers the floor for declining demand and drops items already covered", async () => {
    expect(
      (
        await line({ calculatedNeed: 40, destinationStock: 10 }, [
          [d7, 3.5],
          [d30, 23],
        ])
      ).calculatedNeed
    ).toBe(21);
    expect(
      (
        await forecast({ calculatedNeed: 20, destinationStock: 100 }, [
          [d7, 3.5],
          [d30, 23],
        ])
      ).lines
    ).toEqual([]);
  });

  it("scores historical sell-through", async () => {
    for (const [overallSellThroughPercentage, score, sinceOlder] of [
      [95, 15, 32],
      [80, 13, 32],
      [60, 10, 32],
      [40, 7, 32],
      [10, 4, 32],
      [0, 3, 32],
      [0, 0, 0],
    ]) {
      const result = await line({ overallSellThroughPercentage, totalSalesSinceOlderTransfer: sinceOlder }, STABLE);
      expect([overallSellThroughPercentage, result.scoreBreakdown.historicalSellThrough]).toEqual([
        overallSellThroughPercentage,
        score,
      ]);
    }
  });

  it("scores source availability against the calculated need and caps the allocation", async () => {
    for (const [stock, score, suggested] of [
      [100, 10, 21],
      [35, 10, 21],
      [22, 8, 21],
      [17, 6, 17],
      [12, 4, 12],
      [5, 2, 5],
    ]) {
      const result = await line(NO_HISTORY, STABLE, { stock });
      expect([
        stock,
        result.scoreBreakdown.sourceAvailability,
        result.suggestedQuantity,
        result.calculatedNeed,
      ]).toEqual([stock, score, suggested, 21]);
    }
  });

  it("reserves source stock for the source's own sales", async () => {
    const reserved = await line(NO_HISTORY, STABLE, { sourceSales: 6 });
    expect([reserved.sourceReserveQty, reserved.availableAtSource]).toEqual([3, 97]);
    expect((await line(NO_HISTORY, STABLE, { sourceSales: 3 })).sourceReserveQty).toBe(0);
    expect((await forecast(NO_HISTORY, STABLE, { stock: 2, sourceSales: 30 })).lines).toEqual([]);
  });

  it("scores assortment strength by classification", async () => {
    for (const [classification, score] of [
      ["strong_seller", 5],
      ["good_seller", 4],
      ["normal_seller", 3],
      ["slow_seller", 1],
      ["unclassified", 0],
    ] as const) {
      expect((await line({ classification }, STABLE)).scoreBreakdown.assortmentStrength).toBe(score);
    }
  });

  it("scores data quality by 90-day sales and transfer history", async () => {
    for (const [sales, score] of [
      [[[d90, 20]], 4],
      [[[d90, 10]], 3],
      [[[d90, 3]], 2],
      [[[d90, 1]], 1],
      [[], 0],
    ] as Array<[Sale[], number]>) {
      expect((await line({ olderTransferQty: 0 }, sales)).scoreBreakdown.dataQuality).toBe(score);
    }
    expect((await line({}, STABLE)).scoreBreakdown.dataQuality).toBe(5);
  });

  it("bands the total score", async () => {
    expect((await line(NO_HISTORY, STABLE)).urgencyBand).toBe("critical");
    expect((await line({ ...NO_HISTORY, destinationStock: 20 }, STABLE)).urgencyBand).toBe("high");
    const medium = await line(
      {
        ...NO_HISTORY,
        classification: "unclassified",
        overallSellThroughPercentage: 0,
        totalSalesSinceOlderTransfer: 0,
        destinationStock: 10,
      },
      [
        [d7, 3.5],
        [d30, 23],
      ]
    );
    expect([medium.itemScore, medium.urgencyBand]).toEqual([54, "medium"]);
  });
});

describe("forecast OTW reliability", () => {
  const exact = (eta: string | null, quantity = "10") => ({
    quantity,
    matchType: "exact",
    eta,
    trackingStatus: "At sea",
  });
  it("weights OTW by destination match, tracking status and ETA", async () => {
    const cases: Array<[unknown[], [number, number, number], number]> = [
      [[{ quantity: "4", matchType: "exact", eta: null, trackingStatus: "Discharged at port" }], [4, 4, 4], 1],
      [[{ quantity: "4", matchType: "other", eta: "2026-08-12" }, exact("2026-08-12", "0")], [0, 0, 0], 10],
      [[{ quantity: "10", matchType: "unknown", eta: "2026-08-01" }], [10, 1, 0], 8],
      [[{ quantity: "10", matchType: "unknown", eta: "2026-08-12" }], [10, 3.5, 0], 8],
      [[{ quantity: "10", matchType: "unknown", eta: null }], [10, 1.5, 0], 8],
      [[exact("2026-08-01")], [10, 2, 0], 8],
      [[exact("2026-08-12T10:00:00Z")], [10, 9.5, 9.5], 1],
      [[exact("2026-08-25")], [10, 6.5, 0], 5],
      [[exact("2026-10-25")], [10, 2.5, 0], 8],
      [[exact("garbage")], [10, 2.5, 0], 8],
      [[exact("2026-08-12"), exact("2026-10-25")], [20, 12, 9.5], 3],
      [[exact("2026-08-12"), { quantity: "2", matchType: "unknown", eta: null }], [12, 9.8, 9.5], 1],
    ];
    for (const [otw, quantities, risk] of cases) {
      const result = await line(NO_HISTORY, STABLE, { otw });
      expect([
        result.otwQty,
        result.weightedOtwQty,
        result.reliableOtwBeforeStockoutQty,
        result.scoreBreakdown.otwTimingRisk,
      ]).toEqual([...quantities, risk]);
    }
  });

  it("explains discounted OTW and the reliable share in the line reason", async () => {
    const result = await forecast(NO_HISTORY, STABLE, { otw: [{ quantity: "10", matchType: "unknown", eta: null }] });
    expect(result.lines[0].reason).toContain("10 OTW recorded, 2 counted after ETA/shop reliability weighting");
    expect(result.warnings).toContain(
      "1 item(s) had OTW quantities discounted because destination assignment, ETA or tracking status was uncertain."
    );
  });
});

describe("forecast allocation", () => {
  it("honours an explicit target and reports a shortfall", async () => {
    const capped = await forecast(NO_HISTORY, STABLE, { target: 5 });
    expect([capped.targetQuantity, capped.achievedQuantity, capped.lines[0].suggestedQuantity]).toEqual([5, 5, 5]);
    const short = await forecast(NO_HISTORY, STABLE, { stock: 3, target: 40 });
    expect(short).toMatchObject({ targetQuantity: 40, achievedQuantity: 3, shortfallQuantity: 37, shortfall: true });
    expect(short.warnings).toContain(
      "The forecast preview is short by 37 whole unit(s) because source stock after reserve was insufficient."
    );
  });
});
