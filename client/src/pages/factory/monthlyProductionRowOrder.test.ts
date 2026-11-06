import { describe, expect, it } from "vitest";
import { moveProductNearItem, moveProductToPosition } from "./monthlyProductionRowOrder";

describe("monthly production matrix shared row ordering", () => {
  const ids = [10, 20, 30, 40, 50, 60];

  it("jumps from the bottom to the middle in one move", () => {
    expect(moveProductToPosition(ids, 60, 3)).toEqual([10, 20, 60, 30, 40, 50]);
    expect(ids).toEqual([10, 20, 30, 40, 50, 60]);
  });

  it("moves in both directions with exact final row numbers", () => {
    expect(moveProductToPosition(ids, 10, 5)).toEqual([20, 30, 40, 50, 10, 60]);
    expect(moveProductToPosition(ids, 40, 1)).toEqual([40, 10, 20, 30, 50, 60]);
    expect(moveProductToPosition(ids, 20, 6)).toEqual([10, 30, 40, 50, 60, 20]);
  });

  it("places an item immediately above or below a searched destination", () => {
    expect(moveProductNearItem(ids, 60, 30, "before")).toEqual([10, 20, 60, 30, 40, 50]);
    expect(moveProductNearItem(ids, 60, 30, "after")).toEqual([10, 20, 30, 60, 40, 50]);
    expect(moveProductNearItem(ids, 10, 50, "after")).toEqual([20, 30, 40, 50, 10, 60]);
  });

  it("does not disturb ordering for invalid or unchanged requests", () => {
    expect(moveProductToPosition(ids, 10, 0)).toEqual(ids);
    expect(moveProductToPosition(ids, 10, 7)).toEqual(ids);
    expect(moveProductToPosition(ids, 10, Number.NaN)).toEqual(ids);
    expect(moveProductToPosition(ids, 999, 3)).toEqual(ids);
    expect(moveProductNearItem(ids, 10, 10, "before")).toEqual(ids);
    expect(moveProductNearItem(ids, 10, 999, "after")).toEqual(ids);
  });
});
