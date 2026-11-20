import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const queryResults: unknown[][] = [];
  const buildSmartTransferSourceOptimizedPreview = vi.fn();
  const select = vi.fn(() => {
    const result = queryResults.shift() ?? [];
    const builder: {
      innerJoin: () => typeof builder;
      where: () => Promise<unknown[]>;
    } = {
      innerJoin: () => builder,
      where: async () => result,
    };
    return { from: () => builder };
  });
  return { queryResults, buildSmartTransferSourceOptimizedPreview, select };
});

vi.mock("../server/db", () => ({ db: { select: harness.select } }));
vi.mock("@shared/schema", () => ({
  salesItems: {
    stockItemId: "salesItems.stockItemId",
    quantity: "salesItems.quantity",
    voucherId: "salesItems.voucherId",
  },
  stockCategories: { id: "stockCategories.id", name: "stockCategories.name", companyId: "stockCategories.companyId" },
  stockGroups: {
    id: "stockGroups.id",
    name: "stockGroups.name",
    companyId: "stockGroups.companyId",
    deletedAt: "stockGroups.deletedAt",
  },
  vouchers: {
    id: "vouchers.id",
    companyId: "vouchers.companyId",
    voucherType: "vouchers.voucherType",
    optional: "vouchers.optional",
    deletedAt: "vouchers.deletedAt",
    locationId: "vouchers.locationId",
    voucherDate: "vouchers.voucherDate",
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
vi.mock("../server/services/smartTransferSourceOptimization", () => ({
  buildSmartTransferSourceOptimizedPreview: harness.buildSmartTransferSourceOptimizedPreview,
}));

import { buildSmartTransferBusinessRulePreview } from "../server/services/smartTransferBusinessRules";

function sourceLine(overrides: Record<string, unknown>) {
  return {
    stockItemId: 1,
    stockItemName: "Blue Widget",
    sourceLocationId: 11,
    sourceLocationName: "North Warehouse",
    availableAtSource: 40,
    calculatedNeed: 30,
    suggestedQuantity: 20,
    itemSuggestedTotal: 20,
    categoryId: 101,
    stockGroupId: 201,
    forecastDailyRate: 2,
    itemScore: 70,
    urgencyBand: "medium",
    sourceSelectionScore: 80,
    reason: "Forecast-backed transfer.",
    ...overrides,
  };
}

function sourcePreview(lines: unknown[], targetQuantity = 30) {
  return {
    readOnly: true,
    generatedAt: "2026-08-11T00:00:00.000Z",
    companyId: 4,
    destinationLocationId: 23,
    destinationLocationName: "Riverside Shop",
    sourceLocationIds: [11, 12],
    sourceLocationNames: ["North Warehouse", "South Warehouse"],
    targetQuantity,
    achievedQuantity: targetQuantity,
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
    warnings: ["Phase 2 is short by an obsolete amount"],
    summary: "Source optimization complete.",
    forecastingVersion: 1,
    sourceOptimizationVersion: 2,
  };
}

describe("smart transfer business-rule preview branches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.queryResults.splice(0);
  });

  it("returns the early empty result when lines exist but the resolved target is zero", async () => {
    harness.buildSmartTransferSourceOptimizedPreview.mockResolvedValue(sourcePreview([sourceLine({})], 0));
    const result = await buildSmartTransferBusinessRulePreview(4, [11], 23, 0);
    expect(result.lines).toEqual([]);
    expect(result.businessRules).toMatchObject({
      maxItemSharePct: 30,
      minItemQuantity: 1,
      preserveDestinationMix: true,
    });
    expect(result.summary).toContain("no quantities to balance");
    expect(harness.select).not.toHaveBeenCalled();
  });

  it("handles a single unassigned item with duplicate source lines and skips zero-capacity items", async () => {
    harness.buildSmartTransferSourceOptimizedPreview.mockResolvedValue(
      sourcePreview(
        [
          sourceLine({ categoryId: null, stockGroupId: null, availableAtSource: 5 }),
          // Same source again with more capacity replaces the first option.
          sourceLine({ categoryId: null, stockGroupId: null, availableAtSource: 50 }),
          // Same source again with less capacity is ignored.
          sourceLine({ categoryId: null, stockGroupId: null, availableAtSource: 3 }),
          sourceLine({
            stockItemId: 2,
            stockItemName: "No Need",
            calculatedNeed: 0,
            categoryId: null,
            stockGroupId: null,
          }),
        ],
        12
      )
    );
    // Sales rows only: no category or stock-group lookup is issued.
    harness.queryResults.push([]);

    const result = await buildSmartTransferBusinessRulePreview(4, [11], 23, 12, { preserveDestinationMix: false });

    expect(harness.select).toHaveBeenCalledTimes(1);
    expect(result.achievedQuantity).toBe(12);
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]).toMatchObject({
      stockItemId: 1,
      suggestedQuantity: 12,
      itemBusinessCapQty: 12,
      categoryName: "Unassigned category",
      stockGroupName: "Unassigned stock group",
    });
    expect(result.categoryMix).toEqual([expect.objectContaining({ id: null, quantity: 12, capped: true })]);
    expect(result.businessRulesApplied).toContain("Current forecast demand used as the assortment target");
    expect(result.businessRulesApplied).not.toContain("Priority-category boosts applied");
    expect(result.warnings.some((warning) => /phase 2 is short by/i.test(warning))).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("source split"))).toBe(true);
  });

  it("falls back to numbered names when category and stock-group lookups miss", async () => {
    harness.buildSmartTransferSourceOptimizedPreview.mockResolvedValue(
      sourcePreview(
        [
          sourceLine({ availableAtSource: 40, calculatedNeed: 40 }),
          sourceLine({ stockItemId: 2, stockItemName: "Red", categoryId: 102, stockGroupId: 202, calculatedNeed: 40 }),
        ],
        20
      )
    );
    harness.queryResults.push([], [], []);

    const result = await buildSmartTransferBusinessRulePreview(4, [11], 23, 20, {
      asOfDate: "2026-08-11",
      maxItemSharePct: 50,
      maxCategorySharePct: 50,
      maxStockGroupSharePct: 50,
    });

    expect(result.achievedQuantity).toBe(20);
    expect(result.lines.map((line) => line.categoryName).sort()).toEqual(["Category #101", "Category #102"]);
    expect(result.stockGroupMix.map((row) => row.name).sort()).toEqual(["Stock group #201", "Stock group #202"]);
    expect(result.categoryMix.every((row) => row.capped)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes("relaxed"))).toBe(false);
  });

  it("relaxes caps, removes tiny non-urgent items, splits sources and reports a shortfall", async () => {
    harness.buildSmartTransferSourceOptimizedPreview.mockResolvedValue(
      sourcePreview(
        [
          sourceLine({ availableAtSource: 30, calculatedNeed: 60 }),
          sourceLine({
            sourceLocationId: 12,
            sourceLocationName: "South Warehouse",
            availableAtSource: 30,
            calculatedNeed: 60,
          }),
          sourceLine({
            stockItemId: 2,
            stockItemName: "Tiny",
            categoryId: 102,
            stockGroupId: 202,
            availableAtSource: 2,
            calculatedNeed: 2,
            urgencyBand: "low",
          }),
          sourceLine({
            stockItemId: 3,
            stockItemName: "Urgent Tiny",
            categoryId: 103,
            stockGroupId: 203,
            availableAtSource: 1,
            calculatedNeed: 1,
            urgencyBand: "high",
          }),
        ],
        80
      )
    );
    harness.queryResults.push(
      [{ stockItemId: 1, quantity: "5" }],
      [{ id: 101, name: "Core" }],
      [{ id: 201, name: "Widgets" }]
    );

    const result = await buildSmartTransferBusinessRulePreview(4, [11, 12], 23, 80, {
      maxItemSharePct: 30,
      maxCategorySharePct: 40,
      maxStockGroupSharePct: 40,
      minItemQuantity: 5,
    });

    const byItem = new Map(result.lines.map((line) => [line.stockItemId, line.suggestedQuantity]));
    expect(byItem.has(2)).toBe(false);
    expect(byItem.get(3)).toBe(1);
    expect(result.lines.filter((line) => line.stockItemId === 1)).toHaveLength(2);
    expect(result.achievedQuantity).toBe(61);
    expect(result).toMatchObject({ shortfall: true, shortfallQuantity: 19 });
    expect(result.categoryMix.every((row) => row.capped === false)).toBe(true);
    const text = result.warnings.join("\n");
    expect(text).toContain("relaxed category/stock-group concentration caps");
    expect(text).toContain("relaxed the per-item concentration cap");
    expect(text).toContain("removed 1 non-urgent tiny item");
    expect(text).toContain("Phase 3 is short by 19");
    expect(text).not.toContain("avoided");
  });

  it("uses the automatic minimum for large targets", async () => {
    harness.buildSmartTransferSourceOptimizedPreview.mockResolvedValue(
      sourcePreview([sourceLine({ availableAtSource: 600, calculatedNeed: 600, categoryId: 0, stockGroupId: 0 })], 500)
    );
    harness.queryResults.push([]);
    const result = await buildSmartTransferBusinessRulePreview(4, [11], 23, 500, { minItemQuantity: -3 });
    expect(result.businessRules.minItemQuantity).toBe(8);
    expect(result.achievedQuantity).toBe(500);
  });
});
