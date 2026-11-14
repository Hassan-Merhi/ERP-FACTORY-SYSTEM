import { describe, expect, it } from "vitest";
import { validateSupplierReturnAllocations, type AllocationSource } from "./supplierReturnAllocationReview";

const source = (id: number, remaining = "20", available = "20", overrides: Partial<AllocationSource> = {}): AllocationSource => ({
  offloadItemId: id, locationId: 2, stockItemId: 3, supplierId: 7,
  supplierCount: 1, currencyCount: 1, currency: "USD",
  remainingQty: remaining, availableQty: available, ...overrides,
});
const row = (row: number, quantity: string, candidates: AllocationSource[]) => ({ row, quantity, candidates });
const allocated = (...lines: Array<[number, string]>) =>
  lines.map(([offloadItemId, quantity]) => ({ offloadItemId, quantity }));

describe("ERP supplier return allocation editor", () => {
  it("accepts 17 + 1 for the same imported row", () => {
    const review = validateSupplierReturnAllocations(
      [row(2, "18", [source(1, "17"), source(2, "5")])],
      { 2: allocated([1, "17"], [2, "1"]) },
    );
    expect(review.valid).toBe(true);
    expect(review.entries[0].allocatedQty).toBe("18.000");
    expect(review.entries[0].unallocatedQty).toBe("0.000");
  });

  it("rejects incomplete and over-allocated rows", () => {
    for (const qty of ["17", "19"]) {
      const review = validateSupplierReturnAllocations(
        [row(2, "18", [source(1), source(2)])],
        { 2: allocated([1, qty]) },
      );
      expect(review.valid).toBe(false);
    }
  });

  it("rejects duplicate offload lines even when their sum equals the requested amount", () => {
    const review = validateSupplierReturnAllocations(
      [row(2, "18", [source(1)])],
      { 2: allocated([1, "17"], [1, "1"]) },
    );
    expect(review.valid).toBe(false);
  });

  it("reserves inventory shared by multiple containers and workbook rows", () => {
    const candidates = [source(1, "17", "18"), source(2, "10", "18")];
    const review = validateSupplierReturnAllocations(
      [row(2, "18", candidates), row(3, "1", candidates)],
      { 2: allocated([1, "17"], [2, "1"]), 3: allocated([2, "1"]) },
    );
    expect(review.valid).toBe(false);
    expect(review.overStock.has("2:3")).toBe(true);
    expect(review.overSources.size).toBe(0);
  });

  it("rejects combined over-allocation of a single offload", () => {
    const candidate = source(1, "10", "20");
    const review = validateSupplierReturnAllocations(
      [row(2, "6", [candidate]), row(3, "6", [candidate])],
      { 2: allocated([1, "6"]), 3: allocated([1, "6"]) },
    );
    expect(review.valid).toBe(false);
    expect(review.overSources.has(1)).toBe(true);
  });

  it("allows different location pools without double counting", () => {
    const a = source(1, "5", "5");
    const b = source(2, "5", "5", { locationId: 9 });
    const review = validateSupplierReturnAllocations(
      [row(2, "10", [a, b])], { 2: allocated([1, "5"], [2, "5"]) },
    );
    expect(review.valid).toBe(true);
  });

  it("rejects mixed suppliers, unsupported currencies and malformed quantities", () => {
    const a = source(1), b = source(2, "20", "20", { supplierId: 8 });
    expect(validateSupplierReturnAllocations(
      [row(2, "2", [a, b])], { 2: allocated([1, "1"], [2, "1"]) },
    ).valid).toBe(false);
    expect(validateSupplierReturnAllocations(
      [row(2, "1", [source(3, "20", "20", { currency: "EUR" })])],
      { 2: allocated([3, "1"]) },
    ).valid).toBe(false);
    for (const qty of ["0", "1.2345", "-1", "abc", ""]) {
      expect(validateSupplierReturnAllocations(
        [row(2, "1", [a])], { 2: allocated([1, qty]) },
      ).valid).toBe(false);
    }
  });

  it("rejects missing source and missing allocation selections", () => {
    expect(validateSupplierReturnAllocations(
      [row(2, "2", [source(1)])], { 2: allocated([999, "2"]) },
    ).valid).toBe(false);
    expect(validateSupplierReturnAllocations(
      [row(2, "2", [source(1)])], { 2: [] },
    ).valid).toBe(false);
  });
});
