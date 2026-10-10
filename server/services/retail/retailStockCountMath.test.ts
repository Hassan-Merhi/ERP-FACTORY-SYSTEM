import { describe, expect, it } from "vitest";
import {
  computeRetailStockCountLineStatus,
  finalizeRetailStockCountLine,
  formatRetailStockCountCode,
  nextRetailStockCountQuantity,
  summarizeRetailStockCountLines,
} from "./retailStockCountMath";

describe("stock count line status", () => {
  it("classifies uncounted, counted, unexpected and variance lines", () => {
    expect(computeRetailStockCountLineStatus(5, null)).toBe("uncounted");
    expect(computeRetailStockCountLineStatus(5, 5)).toBe("counted");
    expect(computeRetailStockCountLineStatus(5, 4)).toBe("variance");
    expect(computeRetailStockCountLineStatus(0, 3)).toBe("unexpected");
    expect(computeRetailStockCountLineStatus(0, 0)).toBe("counted");
  });
});

describe("stock count entry quantities", () => {
  it("increments on repeated scans and sets on manual entry", () => {
    expect(nextRetailStockCountQuantity(null, 1, "increment")).toBe(1);
    expect(nextRetailStockCountQuantity(3, 1, "increment")).toBe(4);
    expect(nextRetailStockCountQuantity(3, 0, "set")).toBe(0);
    expect(nextRetailStockCountQuantity(3, 7.5, "set")).toBe(7.5);
    expect(() => nextRetailStockCountQuantity(1, 0, "increment")).toThrow(/greater than zero/);
    expect(() => nextRetailStockCountQuantity(1, -1, "set")).toThrow(/negative/);
  });
});

describe("stock count summary", () => {
  it("totals expected/counted/variance quantities per status", () => {
    const summary = summarizeRetailStockCountLines([
      { expectedQuantity: 10, countedQuantity: 10 },
      { expectedQuantity: 10, countedQuantity: 8 },
      { expectedQuantity: 0, countedQuantity: 2 },
      { expectedQuantity: 5, countedQuantity: null },
    ]);
    expect(summary).toMatchObject({
      lineCount: 4,
      countedLineCount: 3,
      uncountedLineCount: 1,
      varianceLineCount: 1,
      unexpectedLineCount: 1,
      expectedQuantityTotal: 25,
      countedQuantityTotal: 20,
      varianceQuantityTotal: 0,
      absoluteVarianceQuantity: 4,
    });
  });

  it("ignores uncounted lines when totalling", () => {
    const summary = summarizeRetailStockCountLines([{ expectedQuantity: 4, countedQuantity: null }]);
    expect(summary.countedQuantityTotal).toBe(0);
    expect(summary.uncountedLineCount).toBe(1);
    expect(summary.varianceLineCount).toBe(0);
  });
});

describe("stock count finalize delta", () => {
  it("writes counted minus live, not counted minus the snapshot", () => {
    // Snapshot was 10; a POS sale sold 2 during the count and staff counted 8.
    const outcome = finalizeRetailStockCountLine({ expectedQuantity: 10, countedQuantity: 8, liveQuantity: 8 });
    expect(outcome.movementDelta).toBe(0);
    expect(outcome.varianceQuantity).toBe(-2);
    expect(outcome.needsMovement).toBe(false);
  });

  it("corrects the live stock when it drifted from the snapshot", () => {
    const outcome = finalizeRetailStockCountLine({ expectedQuantity: 10, countedQuantity: 7, liveQuantity: 9 });
    expect(outcome.movementDelta).toBe(-2);
    expect(outcome.finalQuantity).toBe(7);
    expect(outcome.needsMovement).toBe(true);
  });

  it("adds unexpected stock", () => {
    const outcome = finalizeRetailStockCountLine({ expectedQuantity: 0, countedQuantity: 3, liveQuantity: 0 });
    expect(outcome.movementDelta).toBe(3);
    expect(outcome.needsMovement).toBe(true);
  });
});

describe("stock count code", () => {
  it("formats a stable per-company code", () => {
    expect(formatRetailStockCountCode(1)).toBe("SC-000001");
    expect(formatRetailStockCountCode(123456)).toBe("SC-123456");
  });
});
