import { describe, expect, it } from "vitest";
import {
  buildContainerPlanReconciliation,
  distributeContainerPlannerProducts,
  type ContainerPlannerSourceRow,
  type SavedPlannerContainer,
} from "../shared/containerPlanner";

function source(
  articleCode: string,
  freeToPromise: number,
  overrides: Partial<ContainerPlannerSourceRow> = {}
): ContainerPlannerSourceRow {
  return {
    articleCode,
    productName: articleCode,
    stockAvailable: Math.max(freeToPromise, 0),
    expectedToLoad: 0,
    totalLoaded: 0,
    freeToPromise,
    ...overrides,
  };
}

function container(
  id: number,
  isLocked: boolean,
  lines: SavedPlannerContainer["lines"],
  position = id - 1
): SavedPlannerContainer {
  return { id, position, isLocked, lines };
}

describe("Factory container planner phase 3 reconciliation", () => {
  it("reports an in-sync plan when current free stock matches every planned product", () => {
    const result = buildContainerPlanReconciliation(
      [source("A", 8), source("B", 4)],
      [
        container(1, false, [
          { articleCode: "A", productName: "A", plannedQty: 4 },
          { articleCode: "B", productName: "B", plannedQty: 2 },
        ]),
        container(2, false, [
          { articleCode: "A", productName: "A", plannedQty: 4 },
          { articleCode: "B", productName: "B", plannedQty: 2 },
        ]),
      ]
    );

    expect(result.status).toBe("IN_SYNC");
    expect(result.currentPlannableTotal).toBe(12);
    expect(result.plannedTotal).toBe(12);
    expect(result.unplannedTotal).toBe(0);
    expect(result.overplannedTotal).toBe(0);
    expect(result.lockedConflictTotal).toBe(0);
  });

  it("separates newly available stock from over-planned stock by product", () => {
    const result = buildContainerPlanReconciliation(
      [source("A", 10), source("B", 2)],
      [
        container(1, false, [
          { articleCode: "A", productName: "A", plannedQty: 4 },
          { articleCode: "B", productName: "B", plannedQty: 3 },
        ]),
        container(2, false, [
          { articleCode: "A", productName: "A", plannedQty: 4 },
          { articleCode: "B", productName: "B", plannedQty: 3 },
        ]),
      ]
    );

    expect(result.status).toBe("DRIFT");
    expect(result.unplannedTotal).toBe(2);
    expect(result.overplannedTotal).toBe(4);
    expect(result.products.find((row) => row.articleCode === "A")?.deltaQty).toBe(2);
    expect(result.products.find((row) => row.articleCode === "B")?.deltaQty).toBe(-4);
  });

  it("flags a locked conflict without treating unlocked over-planning as locked", () => {
    const result = buildContainerPlanReconciliation(
      [source("A", 3)],
      [
        container(1, true, [{ articleCode: "A", productName: "A", plannedQty: 4 }]),
        container(2, false, [{ articleCode: "A", productName: "A", plannedQty: 2 }]),
      ]
    );

    expect(result.status).toBe("LOCKED_CONFLICT");
    expect(result.overplannedTotal).toBe(3);
    expect(result.lockedConflictTotal).toBe(1);
    expect(result.products[0].lockedQty).toBe(4);
  });

  it("keeps excluded garbage/wiper free stock outside the reconciliation target", () => {
    const result = buildContainerPlanReconciliation(
      [source("NORMAL", 5), source("WIPER", 7, { isGarbageOrWipers: true })],
      [container(1, false, [{ articleCode: "NORMAL", productName: "NORMAL", plannedQty: 5 }])],
      { includeGarbageWipers: false }
    );

    expect(result.status).toBe("IN_SYNC");
    expect(result.currentPlannableTotal).toBe(5);
    expect(result.excludedCurrentFreeTotal).toBe(7);
    expect(result.products.some((row) => row.articleCode === "WIPER")).toBe(false);
  });

  it("distributes a reconciliation target evenly while preserving exact product totals", () => {
    const distributed = distributeContainerPlannerProducts(
      [
        { articleCode: "A", productName: "A", qty: 11 },
        { articleCode: "B", productName: "B", qty: 7 },
      ],
      4
    );

    expect(distributed.totals.reduce((sum, qty) => sum + qty, 0)).toBe(18);
    expect(Math.max(...distributed.totals) - Math.min(...distributed.totals)).toBeLessThanOrEqual(1);

    const a = distributed.products.find((row) => row.articleCode === "A");
    const b = distributed.products.find((row) => row.articleCode === "B");
    expect(a?.allocations.reduce((sum, qty) => sum + qty, 0)).toBe(11);
    expect(b?.allocations.reduce((sum, qty) => sum + qty, 0)).toBe(7);
  });
});
