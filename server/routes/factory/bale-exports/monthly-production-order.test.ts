import { describe, expect, it } from "vitest";
import { mergeActiveMatrixOrder } from "./monthly-production-order";

describe("monthly matrix active-only ordering", () => {
  it("preserves hidden inactive items while active items are reordered", () => {
    const active = new Set([1, 3, 5]);
    const company = new Set([1, 2, 3, 4, 5]);
    expect(mergeActiveMatrixOrder([5, 1, 3], [1, 2, 3, 4, 5], active, company))
      .toEqual([5, 2, 1, 4, 3]);
  });

  it("keeps reactivated items in their former positions", () => {
    const company = new Set([1, 2, 3]);
    expect(mergeActiveMatrixOrder([3, 1], [1, 2, 3], new Set([1, 3]), company))
      .toEqual([3, 2, 1]);
    expect(mergeActiveMatrixOrder([3, 2, 1], [3, 2, 1], company, company))
      .toEqual([3, 2, 1]);
  });

  it("drops removed or cross-company IDs from saved layouts and adds newly active products", () => {
    const company = new Set([1, 2, 3]);
    expect(mergeActiveMatrixOrder([3], [1, 999, 2], new Set([1, 3]), company))
      .toEqual([3, 2, 1]);
  });
});
