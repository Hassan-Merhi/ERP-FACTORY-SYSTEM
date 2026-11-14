import Decimal from "decimal.js";

/** A preview is advisory; commit must revalidate stock and source balances under locks. */
export interface ReturnAllocationCandidate {
  offloadItemId: number;
  supplierId: number | null;
  supplierCount: number;
  currencyCount: number;
  currency: string | null;
  stockItemId: number;
  locationId: number;
  remainingQty: string;
  availableQty: string;
}
export interface ReturnAllocationInput<T extends ReturnAllocationCandidate> {
  code: string;
  quantity: string;
  candidates: T[];
  /** Legacy single-source override. The allocation is restricted to that source. */
  offloadItemId?: number | null;
}
export interface ReturnAllocation<T extends ReturnAllocationCandidate> {
  offloadItemId: number;
  quantity: string;
  candidate: T;
}
export interface ReturnAllocationResult<T extends ReturnAllocationCandidate> {
  status: "matched" | "partial" | "insufficient-or-unsupported" | "not-found" | "needs-selection" | "invalid-selection";
  allocations: ReturnAllocation<T>[];
  allocatedQty: string;
  unallocatedQty: string;
  suggestedOffloadItemId: number | null;
}

const zero = new Decimal(0);
const nonNegative = (value: string): Decimal => Decimal.max(new Decimal(value), zero);
const stockKey = (item: ReturnAllocationCandidate) => `${item.locationId}:${item.stockItemId}`;

/**
 * Allocate across workbook rows without double-counting shared location/item inventory.
 * Candidate order comes from the caller (normally newest offload first).
 */
export function allocateSupplierReturnRows<T extends ReturnAllocationCandidate>(
  rows: ReturnAllocationInput<T>[]
): ReturnAllocationResult<T>[] {
  const sourceRemaining = new Map<number, Decimal>();
  const stockRemaining = new Map<string, Decimal>();
  // Pre-initialize all balances; repeated appearances of the same source/stock bucket
  // are one pool, not separate available quantities.
  for (const row of rows) {
    for (const candidate of row.candidates) {
      const source = nonNegative(candidate.remainingQty);
      const bucket = nonNegative(candidate.availableQty);
      const priorSource = sourceRemaining.get(candidate.offloadItemId);
      const priorBucket = stockRemaining.get(stockKey(candidate));
      sourceRemaining.set(candidate.offloadItemId, priorSource ? Decimal.min(priorSource, source) : source);
      stockRemaining.set(stockKey(candidate), priorBucket ? Decimal.min(priorBucket, bucket) : bucket);
    }
  }

  return rows.map((row) => {
    const needed = new Decimal(row.quantity);
    const none = (status: ReturnAllocationResult<T>["status"]): ReturnAllocationResult<T> => ({
      status,
      allocations: [],
      allocatedQty: "0.000",
      unallocatedQty: needed.toFixed(3),
      suggestedOffloadItemId: null,
    });
    if (!row.candidates.length) return none("not-found");
    const selectedId = row.offloadItemId || null;
    if (selectedId && !row.candidates.some((c) => c.offloadItemId === selectedId)) return none("invalid-selection");

    const eligible = row.candidates.filter(
      (c) =>
        (!selectedId || c.offloadItemId === selectedId) &&
        c.supplierId !== null &&
        c.supplierCount === 1 &&
        c.currencyCount === 1 &&
        c.currency === "USD"
    );
    if (!eligible.length) return none("insufficient-or-unsupported");

    // Never silently mix supplier credits across different suppliers for one row.
    if (!selectedId && new Set(eligible.map((c) => c.supplierId)).size > 1) return none("needs-selection");

    const allocations: ReturnAllocation<T>[] = [];
    let remaining = needed;
    const seen = new Set<number>();
    for (const candidate of eligible) {
      if (!remaining.gt(0)) break;
      if (seen.has(candidate.offloadItemId)) continue;
      seen.add(candidate.offloadItemId);
      const source = sourceRemaining.get(candidate.offloadItemId) ?? zero;
      const bucketKey = stockKey(candidate);
      const stock = stockRemaining.get(bucketKey) ?? zero;
      const used = Decimal.min(remaining, source, stock);
      if (!used.gt(0)) continue;
      allocations.push({
        offloadItemId: candidate.offloadItemId,
        quantity: used.toFixed(3),
        candidate,
      });
      sourceRemaining.set(candidate.offloadItemId, source.minus(used));
      stockRemaining.set(bucketKey, stock.minus(used));
      remaining = remaining.minus(used);
    }
    const allocatedQty = needed.minus(remaining);
    return {
      status: remaining.isZero() ? "matched" : allocatedQty.gt(0) ? "partial" : "insufficient-or-unsupported",
      allocations,
      allocatedQty: allocatedQty.toFixed(3),
      unallocatedQty: remaining.toFixed(3),
      suggestedOffloadItemId: remaining.isZero() && allocations.length === 1 ? allocations[0].offloadItemId : null,
    };
  });
}
