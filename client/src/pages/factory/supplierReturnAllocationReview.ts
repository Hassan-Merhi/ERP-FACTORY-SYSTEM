import Decimal from "decimal.js";
import { isValidSupplierReturnQuantity } from "./supplierReturnQuantityValidation";

export interface AllocationSource {
  offloadItemId: number;
  stockItemId: number;
  locationId: number;
  supplierId: number | null;
  supplierCount: number;
  currencyCount: number;
  currency: string | null;
  remainingQty: string;
  availableQty: string;
}
export interface EditableAllocation { offloadItemId: number; quantity: string }
export interface EditableReturnRow<T extends AllocationSource> {
  row: number;
  quantity: string;
  candidates: T[];
}
export interface AllocationReview<T extends AllocationSource> {
  row: EditableReturnRow<T>;
  lines: Array<{ allocation: EditableAllocation; candidate: T | undefined; valid: boolean }>;
  allocatedQty: string;
  unallocatedQty: string;
  valid: boolean;
}
export function validateSupplierReturnAllocations<T extends AllocationSource>(
  rows: EditableReturnRow<T>[],
  allocations: Record<number, EditableAllocation[]>,
): { entries: AllocationReview<T>[]; valid: boolean; overSources: Set<number>; overStock: Set<string> } {
  const sourceDemand = new Map<number, Decimal>();
  const stockDemand = new Map<string, Decimal>();
  const sourceCapacity = new Map<number, Decimal>();
  const stockCapacity = new Map<string, Decimal>();
  const entries = rows.map((row) => {
    const selected = allocations[row.row] ?? [];
    const seen = new Set<number>();
    const suppliers = new Set<number>();
    let allocated = new Decimal(0);
    const lines = selected.map((allocation) => {
      const candidate = row.candidates.find((c) => c.offloadItemId === allocation.offloadItemId);
      const qtyValid = isValidSupplierReturnQuantity(allocation.quantity);
      const eligible = !!candidate && candidate.supplierCount === 1 &&
        candidate.supplierId !== null && candidate.currencyCount === 1 && candidate.currency === "USD";
      const valid = !!candidate && eligible && qtyValid && !seen.has(allocation.offloadItemId);
      seen.add(allocation.offloadItemId);
      if (eligible && candidate?.supplierId !== null) suppliers.add(candidate!.supplierId!);
      if (qtyValid) allocated = allocated.plus(allocation.quantity);
      if (valid && candidate) {
        const qty = new Decimal(allocation.quantity);
        const key = `${candidate.locationId}:${candidate.stockItemId}`;
        sourceDemand.set(candidate.offloadItemId, (sourceDemand.get(candidate.offloadItemId) ?? new Decimal(0)).plus(qty));
        stockDemand.set(key, (stockDemand.get(key) ?? new Decimal(0)).plus(qty));
        const priorSource = sourceCapacity.get(candidate.offloadItemId);
        const priorStock = stockCapacity.get(key);
        const remaining = new Decimal(candidate.remainingQty);
        const available = new Decimal(candidate.availableQty);
        sourceCapacity.set(candidate.offloadItemId, priorSource ? Decimal.min(priorSource, remaining) : remaining);
        stockCapacity.set(key, priorStock ? Decimal.min(priorStock, available) : available);
      }
      return { allocation, candidate, valid };
    });
    const requested = new Decimal(row.quantity);
    return {
      row, lines, allocatedQty: allocated.toFixed(3),
      unallocatedQty: Decimal.max(requested.minus(allocated), 0).toFixed(3),
      valid: lines.length > 0 && lines.every((line) => line.valid) &&
        suppliers.size === 1 && allocated.eq(requested),
    };
  });
  const overSources = new Set([...sourceDemand].filter(([id, qty]) => qty.gt(sourceCapacity.get(id) ?? 0)).map(([id]) => id));
  const overStock = new Set([...stockDemand].filter(([key, qty]) => qty.gt(stockCapacity.get(key) ?? 0)).map(([key]) => key));
  const valid = entries.length > 0 && entries.every((entry) =>
    entry.valid && entry.lines.every(({ candidate }) =>
      candidate && !overSources.has(candidate.offloadItemId) &&
      !overStock.has(`${candidate.locationId}:${candidate.stockItemId}`)
    )
  );
  return { entries, valid, overSources, overStock };
}
