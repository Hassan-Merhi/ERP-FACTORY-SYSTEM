/**
 * Container planner edge cases: capacity normalisation, empty and excluded
 * stock, name and code tie-breaks, rebalancing guards around locked
 * containers, and reconciliation of a saved plan against changed stock.
 */
import { describe, expect, it } from "vitest";
import {
  buildContainerPlannerPreview,
  buildContainerPlanReconciliation,
  DEFAULT_CONTAINER_CAPACITY,
  distributeContainerPlannerProducts,
  MAX_CONTAINER_CAPACITY,
  normalizeContainerCapacity,
  rebalanceUnlockedContainerPlan,
  type ContainerPlannerSourceRow,
} from "../shared/containerPlanner";

const src = (
  articleCode: string,
  freeToPromise: number,
  over: Partial<ContainerPlannerSourceRow> = {}
): ContainerPlannerSourceRow => ({
  articleCode,
  productName: articleCode.toLowerCase(),
  stockAvailable: 0,
  expectedToLoad: 0,
  totalLoaded: 0,
  freeToPromise,
  ...over,
});

describe("capacity and distribution", () => {
  it("normalises capacity to 1..5000 and defaults non-numbers", () => {
    expect(normalizeContainerCapacity(Number.NaN)).toBe(DEFAULT_CONTAINER_CAPACITY);
    expect(normalizeContainerCapacity(0)).toBe(1);
    expect(normalizeContainerCapacity(12.9)).toBe(12);
    expect(normalizeContainerCapacity(1e9)).toBe(MAX_CONTAINER_CAPACITY);
  });

  it("returns nothing without containers and skips non-positive quantities", () => {
    expect(distributeContainerPlannerProducts([{ articleCode: "A", productName: "a", qty: 5 }], 0)).toEqual({
      totals: [],
      products: [],
    });
    expect(
      distributeContainerPlannerProducts(
        [
          { articleCode: "A", productName: "a", qty: 0 },
          { articleCode: "B", productName: "b", qty: Number.NaN },
          { articleCode: "C", productName: "c", qty: 2 },
        ],
        3
      )
    ).toEqual({
      totals: [1, 1, 0],
      products: [{ articleCode: "C", productName: "c", plannableQty: 2, allocations: [1, 1, 0] }],
    });
  });
});

describe("buildContainerPlannerPreview", () => {
  it("reports an empty plan with the stock picture when nothing is free", () => {
    const preview = buildContainerPlannerPreview([
      src("A", -4.7, { stockAvailable: 10, expectedToLoad: 12, totalLoaded: Number.NaN }),
      src("B", Number.NaN, { stockAvailable: -3 }),
    ]);
    expect(preview).toEqual({
      capacity: DEFAULT_CONTAINER_CAPACITY,
      containerCount: 0,
      totalPlannable: 0,
      averageBalesPerContainer: 0,
      totalStockAvailable: 10,
      customerCommitted: 12,
      alreadyLoading: 0,
      shortageBales: 4,
      excludedFromPlan: 0,
      products: [],
      containers: [],
    });
  });

  it("leaves garbage and wipers out unless included, and orders by name then code", () => {
    const rows = [
      src("Z1", 3, { productName: "" }),
      src("W1", 5, { productName: "Wipers", isGarbageOrWipers: true }),
      src("B2", 2, { productName: "Same" }),
      src("B1", 1, { productName: "Same" }),
    ];
    const excluded = buildContainerPlannerPreview(rows, 4);
    expect(excluded).toMatchObject({
      totalPlannable: 6,
      excludedFromPlan: 5,
      containerCount: 2,
      averageBalesPerContainer: 3,
    });
    expect(excluded.products.map((p) => [p.articleCode, p.productName])).toEqual([
      ["B1", "Same"],
      ["B2", "Same"],
      ["Z1", "Z1"],
    ]);
    expect(excluded.containers).toEqual([
      { index: 0, label: "Container 1", totalBales: 3, fillPercent: 75 },
      { index: 1, label: "Container 2", totalBales: 3, fillPercent: 75 },
    ]);
    const included = buildContainerPlannerPreview(rows, 4, { includeGarbageWipers: true });
    expect(included).toMatchObject({ totalPlannable: 11, excludedFromPlan: 0, containerCount: 3 });
  });
});

describe("rebalanceUnlockedContainerPlan", () => {
  const line = (articleCode: string, plannedQty: number, productName = articleCode) => ({
    articleCode,
    productName,
    plannedQty,
  });

  it("keeps locked containers and spreads the remainder over unlocked ones in position order", () => {
    const result = rebalanceUnlockedContainerPlan(
      [
        { id: 3, position: 1, isLocked: false, lines: [line("A", 4)] },
        { id: 2, position: 0, isLocked: true, lines: [line("A", 2), line("B", 1, "")] },
        { id: 1, position: 1, isLocked: false, lines: [line("B", 3)] },
      ],
      10
    );
    expect(result).toEqual([
      { containerId: 1, lines: [line("A", 2), line("B", 2)] },
      { containerId: 3, lines: [line("A", 2), line("B", 1)] },
    ]);
  });

  it("empties unlocked containers when locked ones already hold everything", () => {
    expect(
      rebalanceUnlockedContainerPlan(
        [
          { id: 1, position: 0, isLocked: true, lines: [line("A", 3)] },
          { id: 2, position: 1, isLocked: false, lines: [] },
        ],
        5
      )
    ).toEqual([{ containerId: 2, lines: [] }]);
  });

  it("refuses an over-capacity container and has nothing to do when all are locked", () => {
    expect(() =>
      rebalanceUnlockedContainerPlan([{ id: 1, position: 2, isLocked: false, lines: [line("A", 6)] }], 5)
    ).toThrow("Container 3 exceeds the 5-bale capacity.");
    // With every container locked nothing remains to place, so there is nothing to rebalance.
    expect(rebalanceUnlockedContainerPlan([{ id: 1, position: 0, isLocked: true, lines: [line("A", 3)] }], 5)).toEqual(
      []
    );
  });
});

describe("buildContainerPlanReconciliation", () => {
  it("is in sync when the plan matches free stock", () => {
    const result = buildContainerPlanReconciliation(
      [src("A", 4)],
      [{ id: 1, position: 0, isLocked: false, lines: [{ articleCode: "A", productName: "a", plannedQty: 4 }] }]
    );
    expect(result).toMatchObject({ status: "IN_SYNC", plannedTotal: 4, currentPlannableTotal: 4 });
  });

  it("reports drift, locked conflicts, shortages and excluded stock", () => {
    const result = buildContainerPlanReconciliation(
      [
        src("A", 2, { stockAvailable: 10, expectedToLoad: 5, totalLoaded: 3 }),
        src("B", -3),
        src("W", 6, { isGarbageOrWipers: true }),
        src("", 9),
        src("N", 5, { productName: "" }),
      ],
      [
        {
          id: 1,
          position: 0,
          isLocked: true,
          lines: [
            { articleCode: "A", productName: "", plannedQty: 3 },
            { articleCode: "W", productName: "Wipers", plannedQty: 2 },
          ],
        },
        {
          id: 2,
          position: 1,
          isLocked: false,
          lines: [
            { articleCode: "A", productName: "Alpha", plannedQty: 1 },
            { articleCode: "GONE", productName: "", plannedQty: 2 },
            { articleCode: "", productName: "blank", plannedQty: 1 },
            { articleCode: "Z", productName: "z", plannedQty: 0 },
          ],
        },
      ]
    );
    expect(result).toMatchObject({
      status: "LOCKED_CONFLICT",
      currentStockTotal: 10,
      currentCommittedTotal: 5,
      currentLoadingTotal: 3,
      currentPlannableTotal: 16,
      stockShortageTotal: 3,
      excludedCurrentFreeTotal: 6,
      plannedTotal: 8,
      unplannedTotal: 5,
      overplannedTotal: 6,
      lockedConflictTotal: 3,
    });
    expect(
      result.products.map((p) => [
        p.articleCode,
        p.productName,
        p.plannedQty,
        p.lockedQty,
        p.currentPlannableQty,
        p.deltaQty,
        p.lockedConflictQty,
      ])
    ).toEqual([
      ["A", "a", 4, 3, 2, -2, 1],
      ["GONE", "GONE", 2, 0, 0, -2, 0],
      ["N", "N", 0, 0, 5, 5, 0],
      ["W", "w", 2, 2, 0, -2, 2],
    ]);
    const withWipers = buildContainerPlanReconciliation([src("W", 6, { isGarbageOrWipers: true })], [], {
      includeGarbageWipers: true,
    });
    expect(withWipers).toMatchObject({
      status: "DRIFT",
      currentPlannableTotal: 6,
      excludedCurrentFreeTotal: 0,
      unplannedTotal: 6,
    });
  });
});
