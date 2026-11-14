import { describe, expect, it } from "vitest";
import {
  allocateSupplierReturnRows,
  type ReturnAllocationCandidate,
} from "./erpSupplierReturnAllocation";

function candidate(
  offloadItemId: number,
  remainingQty: string,
  availableQty = "100",
  overrides: Partial<ReturnAllocationCandidate> = {},
): ReturnAllocationCandidate {
  return {
    offloadItemId, supplierId: 7, supplierCount: 1,
    currencyCount: 1, currency: "USD", stockItemId: 11,
    locationId: 2, remainingQty, availableQty, ...overrides,
  };
}
const row = (quantity: string, candidates: ReturnAllocationCandidate[], offloadItemId?: number) => ({
  code: "HMD12034", quantity, candidates, offloadItemId,
});

describe("ERP supplier return automatic allocation", () => {
  it("splits a requested 18 into 17 + 1, keeping legacy single-source hint unset", () => {
    const [result] = allocateSupplierReturnRows([
      row("18", [candidate(101, "17", "18"), candidate(102, "9", "18")]),
    ]);
    expect(result.status).toBe("matched");
    expect(result.allocations.map((a) => [a.offloadItemId, a.quantity]))
      .toEqual([[101, "17.000"], [102, "1.000"]]);
    expect(result.allocatedQty).toBe("18.000");
    expect(result.unallocatedQty).toBe("0.000");
    expect(result.suggestedOffloadItemId).toBeNull();
  });

  it("supports three sources and decimal quantities", () => {
    const [result] = allocateSupplierReturnRows([
      row("3.375", [candidate(1, "1.125"), candidate(2, "1.250"), candidate(3, "5")]),
    ]);
    expect(result.allocations.map((a) => a.quantity)).toEqual(["1.125", "1.250", "1.000"]);
    expect(result.status).toBe("matched");
  });

  it("does not count the same location/item stock balance once per container", () => {
    const [result] = allocateSupplierReturnRows([
      row("18", [candidate(1, "17", "17.5"), candidate(2, "10", "17.5")]),
    ]);
    expect(result.status).toBe("partial");
    expect(result.allocatedQty).toBe("17.500");
    expect(result.unallocatedQty).toBe("0.500");
    expect(result.allocations.map((a) => a.quantity)).toEqual(["17.000", "0.500"]);
  });

  it("reserves the same stock bucket and source across duplicate upload rows", () => {
    const source = candidate(1, "20", "18");
    const [first, second, third] = allocateSupplierReturnRows([
      row("10", [source]), row("10", [source]), row("1", [source]),
    ]);
    expect(first.status).toBe("matched");
    expect(first.suggestedOffloadItemId).toBe(1);
    expect(second.status).toBe("partial");
    expect(second.allocatedQty).toBe("8.000");
    expect(third.status).toBe("insufficient-or-unsupported");
    expect(third.allocations).toHaveLength(0);
  });

  it("shares a bucket across different offloads but not separate locations", () => {
    const [first, second] = allocateSupplierReturnRows([
      row("6", [candidate(1, "10", "6")]),
      row("8", [candidate(2, "10", "6"), candidate(3, "10", "3", { locationId: 9 })]),
    ]);
    expect(first.status).toBe("matched");
    expect(second.status).toBe("partial");
    expect(second.allocatedQty).toBe("3.000");
    expect(second.allocations[0].offloadItemId).toBe(3);
  });

  it("requires review rather than silently mixing suppliers in one row", () => {
    const [result] = allocateSupplierReturnRows([
      row("6", [candidate(1, "3"), candidate(2, "4", "100", { supplierId: 8 })]),
    ]);
    expect(result.status).toBe("needs-selection");
    expect(result.allocations).toEqual([]);
  });

  it("ignores unsupported currency and supplier sources", () => {
    const [result] = allocateSupplierReturnRows([
      row("6", [
        candidate(1, "100", "100", { currency: "EUR" }),
        candidate(2, "4", "100", { supplierCount: 2 }),
        candidate(3, "6"),
      ]),
    ]);
    expect(result.status).toBe("matched");
    expect(result.allocations.map((a) => a.offloadItemId)).toEqual([3]);
  });

  it("respects explicit legacy source selection and invalid selection", () => {
    const candidates = [candidate(1, "4"), candidate(2, "10")];
    const [limited, invalid] = allocateSupplierReturnRows([
      row("6", candidates, 1), row("2", candidates, 999),
    ]);
    expect(limited.status).toBe("partial");
    expect(limited.allocations.map((a) => a.offloadItemId)).toEqual([1]);
    expect(invalid.status).toBe("invalid-selection");
  });

  it("returns not-found and preserves source order while deduplicating source IDs", () => {
    const [missing, duplicate] = allocateSupplierReturnRows([
      row("1", []),
      row("4", [candidate(2, "2"), candidate(2, "2"), candidate(3, "5")]),
    ]);
    expect(missing.status).toBe("not-found");
    expect(duplicate.allocations.map((a) => [a.offloadItemId, a.quantity]))
      .toEqual([[2, "2.000"], [3, "2.000"]]);
  });
});
