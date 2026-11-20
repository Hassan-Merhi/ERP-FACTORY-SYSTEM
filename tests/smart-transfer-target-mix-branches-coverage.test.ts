import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ buildSmartTransferBusinessRulePreview: vi.fn() }));

vi.mock("../server/services/smartTransferBusinessRules", () => ({
  buildSmartTransferBusinessRulePreview: harness.buildSmartTransferBusinessRulePreview,
}));

import { buildSmartTransferTargetBalancedPreview } from "../server/services/smartTransferTargetMix";

function line(overrides: Record<string, unknown>) {
  return {
    stockItemId: 1,
    stockItemName: "Blue Widget",
    sourceLocationId: 11,
    sourceLocationName: "North Warehouse",
    suggestedQuantity: 30,
    categoryId: 101,
    stockGroupId: 201,
    businessPriorityScore: 80,
    itemScore: 75,
    sourceSelectionScore: 90,
    forecastDailyRate: 2,
    mixAdjustmentReason: "Original balance.",
    reason: "Original source decision.",
    ...overrides,
  };
}

function mixRow(id: number | null, name: string, targetSharePct: number) {
  return {
    id,
    name,
    targetSharePct,
    finalSharePct: targetSharePct,
    quantity: 0,
    historicalSalesQty: 0,
    capped: false,
    priority: false,
  };
}

function preview(
  lines: unknown[],
  achievedQuantity: number,
  rules: Partial<Record<"maxItemSharePct" | "maxCategorySharePct" | "maxStockGroupSharePct", number>> = {},
  mixes: { categoryMix?: unknown[]; stockGroupMix?: unknown[] } = {}
) {
  return {
    companyId: 4,
    targetQuantity: achievedQuantity,
    achievedQuantity,
    shortfallQuantity: 0,
    shortfall: false,
    lines,
    totalsBySource: [],
    warnings: ["Base warning."],
    summary: "Full pool.",
    businessRules: {
      maxItemSharePct: 50,
      maxCategorySharePct: 50,
      maxStockGroupSharePct: 50,
      ...rules,
    },
    categoryMix: mixes.categoryMix ?? [mixRow(101, "Core", 50), mixRow(102, "Seasonal", 50)],
    stockGroupMix: mixes.stockGroupMix ?? [mixRow(201, "Widgets", 50), mixRow(202, "Accessories", 50)],
  };
}

const sum = (rows: Array<{ suggestedQuantity: number }>) =>
  rows.reduce((total, row) => total + row.suggestedQuantity, 0);

describe("smart transfer manual target balancing branches", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns the full preview untouched when the pool has no lines even with a manual target", async () => {
    const full = preview([], 0);
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(full);
    const result = await buildSmartTransferTargetBalancedPreview(4, [11], 23, 10);
    expect(result).toBe(full);
    expect(harness.buildSmartTransferBusinessRulePreview).toHaveBeenCalledWith(4, [11], 23, 0, {});
  });

  it("keeps base warnings when the manual target exactly equals the full pool", async () => {
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(preview([line({})], 30));
    const result = await buildSmartTransferTargetBalancedPreview(4, [11], 23, 30.9);
    expect(result).toMatchObject({ targetQuantity: 30, shortfallQuantity: 0, shortfall: false });
    expect(result.warnings).toEqual(["Base warning."]);
    expect(result.summary).toContain("produced 30 of 30");
  });

  it("treats a negative target as automatic and returns the full pool", async () => {
    const full = preview([line({})], 30);
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(full);
    expect(await buildSmartTransferTargetBalancedPreview(4, [11], 23, -5)).toBe(full);
  });

  it("gives a single unassigned item the whole target and splits it across sources when none covers it alone", async () => {
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(
      preview(
        [
          line({ categoryId: null, stockGroupId: null, suggestedQuantity: 6, sourceSelectionScore: 50 }),
          line({
            categoryId: null,
            stockGroupId: null,
            sourceLocationId: 12,
            sourceLocationName: "South Warehouse",
            suggestedQuantity: 6,
            sourceSelectionScore: 50,
          }),
          line({
            categoryId: null,
            stockGroupId: null,
            sourceLocationId: 13,
            sourceLocationName: "Empty Depot",
            suggestedQuantity: 0,
            sourceSelectionScore: 99,
          }),
        ],
        12,
        {},
        {
          categoryMix: [mixRow(null, "Unassigned category", 100)],
          stockGroupMix: [mixRow(null, "Unassigned stock group", 100)],
        }
      )
    );

    const result = await buildSmartTransferTargetBalancedPreview(4, [11, 12, 13], 23, 10);

    expect(result.achievedQuantity).toBe(10);
    expect(result.lines.map((row) => [row.sourceLocationName, row.suggestedQuantity])).toEqual([
      ["North Warehouse", 6],
      ["South Warehouse", 4],
    ]);
    expect(result.lines.every((row) => row.itemBusinessCapQty === 10)).toBe(true);
    expect(result.totalsBySource.map((row) => row.sourceLocationId)).toEqual([11, 12]);
    expect(result.categoryMix[0]).toMatchObject({ id: null, quantity: 10, finalSharePct: 100 });
    expect(result.warnings).toEqual(["Base warning."]);
  });

  it("relaxes bucket caps and then item caps when strict caps cannot fill the target", async () => {
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(
      preview(
        [
          line({ suggestedQuantity: 40 }),
          line({
            stockItemId: 2,
            stockItemName: "Tiny Gadget",
            sourceLocationId: 12,
            sourceLocationName: "South Warehouse",
            suggestedQuantity: 1,
            categoryId: 102,
            stockGroupId: 202,
          }),
          line({ stockItemId: 3, stockItemName: "Dead Stock", suggestedQuantity: 0, categoryId: 103 }),
        ],
        41,
        { maxItemSharePct: 50, maxCategorySharePct: 40, maxStockGroupSharePct: 40 },
        // Category 103 has no mix row: its target share falls back to zero.
        {}
      )
    );

    const result = await buildSmartTransferTargetBalancedPreview(4, [11, 12], 23, 20);

    expect(result.achievedQuantity).toBe(20);
    expect(result.shortfall).toBe(false);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("relaxed category/stock-group caps"),
        expect.stringContaining("relaxed the per-item cap"),
      ])
    );
    const byItem = new Map(result.lines.map((row) => [row.stockItemId, row.suggestedQuantity]));
    expect(byItem.get(1)).toBe(19);
    expect(byItem.get(2)).toBe(1);
    expect(byItem.has(3)).toBe(false);
    expect(result.categoryMix.map((row) => row.quantity)).toEqual([19, 1]);
  });

  it("reports a remaining shortfall when the line capacity is below the advertised pool", async () => {
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(
      preview(
        [
          line({ suggestedQuantity: 3 }),
          line({
            stockItemId: 2,
            stockItemName: "Amber Widget",
            suggestedQuantity: 2,
            categoryId: 102,
            stockGroupId: 202,
          }),
        ],
        100
      )
    );

    const result = await buildSmartTransferTargetBalancedPreview(4, [11], 23, 50);

    expect(result).toMatchObject({ targetQuantity: 50, achievedQuantity: 5, shortfallQuantity: 45, shortfall: true });
    expect(result.warnings.at(-1)).toContain("remains short by 45 unit(s)");
    expect(sum(result.lines)).toBe(5);
  });

  it("orders equal-weight items by name and equal mix rows by name", async () => {
    const twin = { suggestedQuantity: 10, businessPriorityScore: 50, forecastDailyRate: 1, itemScore: 50 };
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(
      preview(
        [
          line({ ...twin, stockItemId: 5, stockItemName: "Zeta" }),
          line({ ...twin, stockItemId: 6, stockItemName: "Alpha", categoryId: 102, stockGroupId: 202 }),
        ],
        20,
        { maxItemSharePct: 100, maxCategorySharePct: 100, maxStockGroupSharePct: 100 }
      )
    );

    const result = await buildSmartTransferTargetBalancedPreview(4, [11], 23, 10);

    expect(sum(result.lines)).toBe(10);
    expect(result.lines.map((row) => row.stockItemName)).toEqual(["Alpha", "Zeta"]);
    expect(result.categoryMix.map((row) => row.name)).toEqual(["Core", "Seasonal"]);
    expect(result.categoryMix.map((row) => row.quantity)).toEqual([5, 5]);
  });

  it("prefers higher business priority among equal weights and the larger source among equal scores", async () => {
    harness.buildSmartTransferBusinessRulePreview.mockResolvedValue(
      preview(
        [
          line({
            stockItemId: 7,
            stockItemName: "Low",
            businessPriorityScore: 0,
            forecastDailyRate: 0,
            suggestedQuantity: 1,
          }),
          line({
            stockItemId: 8,
            stockItemName: "High",
            businessPriorityScore: 1,
            forecastDailyRate: 0,
            suggestedQuantity: 1,
          }),
          line({
            stockItemId: 9,
            stockItemName: "Big",
            sourceLocationId: 21,
            sourceLocationName: "B",
            suggestedQuantity: 4,
          }),
          line({
            stockItemId: 9,
            stockItemName: "Big",
            sourceLocationId: 22,
            sourceLocationName: "A",
            suggestedQuantity: 4,
          }),
          line({
            stockItemId: 9,
            stockItemName: "Big",
            sourceLocationId: 23,
            sourceLocationName: "C",
            suggestedQuantity: 9,
          }),
        ],
        19,
        { maxItemSharePct: 100, maxCategorySharePct: 100, maxStockGroupSharePct: 100 }
      )
    );

    const result = await buildSmartTransferTargetBalancedPreview(4, [21, 22, 23], 23, 10);

    expect(sum(result.lines)).toBe(10);
    const big = result.lines.filter((row) => row.stockItemId === 9);
    // Source "C" alone covers the item quantity, so no split is made.
    expect(big).toHaveLength(1);
    expect(big[0].sourceLocationName).toBe("C");
  });
});
