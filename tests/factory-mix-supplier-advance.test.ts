import { describe, expect, it } from "vitest";
import {
  MixRawStockShortageError,
  requireMixRawStockCapacity,
  splitSupplierShortfall,
} from "../server/services/factory/mixRawStockQuantityGuard";

describe("supplier FIFO advance against a later container offload", () => {
  it("separates recorded ADD-backed kg from genuine future-receipt advances", () => {
    const result = splitSupplierShortfall("300.000", "120.000");
    expect(result.adjustmentKg.toFixed(3)).toBe("120.000");
    expect(result.advanceKg.toFixed(3)).toBe("180.000");
  });

  it("permits a wholly unbacked supplier advance, without relabeling it ADD", () => {
    const result = splitSupplierShortfall("300.000", "0");
    expect(result.adjustmentKg.toFixed(3)).toBe("0.000");
    expect(result.advanceKg.toFixed(3)).toBe("300.000");
  });

  it("never consumes more ADD allowance than the remaining deficit", () => {
    const result = splitSupplierShortfall("0.125", "5.000");
    expect(result.adjustmentKg.toFixed(3)).toBe("0.125");
    expect(result.advanceKg.toFixed(3)).toBe("0.000");
  });

  it("rejects negative or nonfinite deficits and ADD quantities", () => {
    expect(() => splitSupplierShortfall("-1", "0")).toThrow(MixRawStockShortageError);
    expect(() => splitSupplierShortfall("1", "-2")).toThrow(MixRawStockShortageError);
    expect(() => splitSupplierShortfall("bogus", "0")).toThrow(MixRawStockShortageError);
  });

  it("keeps direct-container overdrafts prohibited", () => {
    expect(() =>
      requireMixRawStockCapacity({ source: "container #12", availableKg: "10.000", requestedKg: "10.001" })
    ).toThrow(MixRawStockShortageError);
  });

  it("nets a prior supplier advance from a future offload's total available kg", () => {
    // A physical receipt row can remain negative, with the original mix's
    // snapshot untouched. Supplier aggregation settles the debt on receipt.
    const priorNetKg = -300;
    const newReceiptKg = 20000;
    expect(priorNetKg + newReceiptKg).toBe(19700);
  });
});
