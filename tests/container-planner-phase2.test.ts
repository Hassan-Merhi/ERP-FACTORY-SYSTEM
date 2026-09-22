import { describe, expect, it } from "vitest";
import { rebalanceUnlockedContainerPlan, type SavedPlannerContainer } from "../shared/containerPlanner";

function container(
  id: number,
  position: number,
  isLocked: boolean,
  lines: SavedPlannerContainer["lines"]
): SavedPlannerContainer {
  return { id, position, isLocked, lines };
}

describe("Factory container planner phase 2 rebalance", () => {
  it("keeps locked containers untouched and redistributes only unlocked quantities", () => {
    const source: SavedPlannerContainer[] = [
      container(1, 0, true, [
        { articleCode: "CWR", productName: "CWR", plannedQty: 11 },
        { articleCode: "JEANS", productName: "Jeans", plannedQty: 89 },
      ]),
      container(2, 1, false, [
        { articleCode: "CWR", productName: "CWR", plannedQty: 20 },
        { articleCode: "JEANS", productName: "Jeans", plannedQty: 70 },
      ]),
      container(3, 2, false, [
        { articleCode: "CWR", productName: "CWR", plannedQty: 9 },
        { articleCode: "JEANS", productName: "Jeans", plannedQty: 91 },
      ]),
    ];

    const result = rebalanceUnlockedContainerPlan(source, 600);

    expect(result.map((row) => row.containerId)).toEqual([2, 3]);

    const cwrTotal = result
      .flatMap((row) => row.lines)
      .filter((line) => line.articleCode === "CWR")
      .reduce((sum, line) => sum + line.plannedQty, 0);
    const jeansTotal = result
      .flatMap((row) => row.lines)
      .filter((line) => line.articleCode === "JEANS")
      .reduce((sum, line) => sum + line.plannedQty, 0);

    expect(cwrTotal).toBe(29);
    expect(jeansTotal).toBe(161);

    const unlockedTotals = result.map((row) => row.lines.reduce((sum, line) => sum + line.plannedQty, 0));
    expect(Math.max(...unlockedTotals) - Math.min(...unlockedTotals)).toBeLessThanOrEqual(1);

    // The locked container is not returned, which is the contract used by the
    // route when it deletes/replaces unlocked lines only.
    expect(result.some((row) => row.containerId === 1)).toBe(false);
  });

  it("preserves product totals exactly across a mixed locked/unlocked plan", () => {
    const source: SavedPlannerContainer[] = [
      container(10, 0, true, [
        { articleCode: "A", productName: "A", plannedQty: 3 },
        { articleCode: "B", productName: "B", plannedQty: 2 },
      ]),
      container(11, 1, false, [
        { articleCode: "A", productName: "A", plannedQty: 7 },
        { articleCode: "B", productName: "B", plannedQty: 8 },
      ]),
      container(12, 2, false, [
        { articleCode: "A", productName: "A", plannedQty: 10 },
        { articleCode: "B", productName: "B", plannedQty: 10 },
      ]),
    ];

    const result = rebalanceUnlockedContainerPlan(source, 20);
    const totals = new Map<string, number>();
    for (const row of result) {
      for (const line of row.lines) {
        totals.set(line.articleCode, (totals.get(line.articleCode) ?? 0) + line.plannedQty);
      }
    }

    expect(totals.get("A")).toBe(17);
    expect(totals.get("B")).toBe(18);
    expect(result.every((row) => row.lines.reduce((sum, line) => sum + line.plannedQty, 0) <= 20)).toBe(true);
  });

  it("rejects a rebalance when a saved container already holds more than the capacity", () => {
    // A saved container above capacity means the plan is already inconsistent,
    // so the rebalance refuses rather than silently re-spreading bad data. This
    // check fires before the unlocked-capacity guard: with every container
    // within capacity, the quantities in unlocked containers always fit back
    // into those same containers, so that guard is purely defensive.
    const source: SavedPlannerContainer[] = [
      container(1, 0, true, [{ articleCode: "A", productName: "A", plannedQty: 1 }]),
      container(2, 1, false, [{ articleCode: "A", productName: "A", plannedQty: 19 }]),
    ];

    expect(() => rebalanceUnlockedContainerPlan(source, 10)).toThrow(/Container 2 exceeds the 10-bale capacity/i);
  });

  it("has nothing to rebalance when every container is locked", () => {
    const source: SavedPlannerContainer[] = [
      container(1, 0, true, [{ articleCode: "A", productName: "A", plannedQty: 5 }]),
      container(2, 1, true, [{ articleCode: "A", productName: "A", plannedQty: 5 }]),
    ];

    // Locked quantities are preserved as-is, so no unlocked container is
    // returned and the locked plan is left exactly alone.
    expect(rebalanceUnlockedContainerPlan(source, 10)).toEqual([]);
  });

  it("returns empty replacement lines when all remaining quantities are already locked", () => {
    const source: SavedPlannerContainer[] = [
      container(1, 0, true, [{ articleCode: "A", productName: "A", plannedQty: 10 }]),
      container(2, 1, false, []),
    ];

    expect(rebalanceUnlockedContainerPlan(source, 10)).toEqual([{ containerId: 2, lines: [] }]);
  });
});
