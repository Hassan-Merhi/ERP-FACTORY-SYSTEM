import { describe, expect, it } from "vitest";
import {
  buildContainerPlannerPreview,
  normalizeContainerCapacity,
  type ContainerPlannerSourceRow,
} from "../client/src/pages/factory/factorystockallocationv5/containerPlannerEngine";

function row(
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

describe("Factory container planner phase 1", () => {
  it("balances 4,998 bales across nine 600-bale containers without exceeding capacity", () => {
    const preview = buildContainerPlannerPreview(
      [row("CWR", 98), row("JEANS", 800), row("BLOUSE", 1300), row("SHOES", 2100), row("OTHER", 700)],
      600
    );

    expect(preview.totalPlannable).toBe(4998);
    expect(preview.containerCount).toBe(9);

    const totals = preview.containers.map((container) => container.totalBales);
    expect(Math.max(...totals)).toBeLessThanOrEqual(600);
    expect(Math.max(...totals) - Math.min(...totals)).toBeLessThanOrEqual(1);
    expect(totals.reduce((sum, value) => sum + value, 0)).toBe(4998);
  });

  it("spreads a 98-bale product across nine containers as ten or eleven each", () => {
    const preview = buildContainerPlannerPreview([row("CWR", 98), row("FILLER", 4900)], 600);
    const cwr = preview.products.find((product) => product.articleCode === "CWR");

    expect(cwr).toBeDefined();
    expect(cwr!.allocations).toHaveLength(9);
    expect(cwr!.allocations.reduce((sum, value) => sum + value, 0)).toBe(98);
    expect(new Set(cwr!.allocations)).toEqual(new Set([10, 11]));
  });

  it("uses only positive free-to-promise stock and keeps shortages out of the plan", () => {
    const preview = buildContainerPlannerPreview([
      row("FREE", 100, { stockAvailable: 120, expectedToLoad: 20 }),
      row("SHORT", -7, { stockAvailable: 3, expectedToLoad: 10 }),
    ]);

    expect(preview.totalPlannable).toBe(100);
    expect(preview.shortageBales).toBe(7);
    expect(preview.products.map((product) => product.articleCode)).toEqual(["FREE"]);
  });

  it("excludes garbage/wipers by default but can include them explicitly", () => {
    const source = [
      row("CWR", 100),
      row("WIPER", 50, { isGarbageOrWipers: true }),
    ];

    const defaultPreview = buildContainerPlannerPreview(source, 600);
    const includedPreview = buildContainerPlannerPreview(source, 600, { includeGarbageWipers: true });

    expect(defaultPreview.totalPlannable).toBe(100);
    expect(defaultPreview.excludedFromPlan).toBe(50);
    expect(includedPreview.totalPlannable).toBe(150);
    expect(includedPreview.excludedFromPlan).toBe(0);
  });

  it("normalizes invalid capacities safely", () => {
    expect(normalizeContainerCapacity(Number.NaN)).toBe(600);
    expect(normalizeContainerCapacity(0)).toBe(1);
    expect(normalizeContainerCapacity(999999)).toBe(5000);
    expect(normalizeContainerCapacity(600.9)).toBe(600);
  });
});
