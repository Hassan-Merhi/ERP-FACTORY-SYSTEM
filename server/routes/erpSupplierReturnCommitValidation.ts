import Decimal from "decimal.js";

export interface ReturnCommitLine { offloadItemId: number; quantity: string }
export interface ReturnCommitRow {
  code: string;
  quantity: string;
  allocations: ReturnCommitLine[];
}
const positiveQty = (raw: unknown): Decimal => {
  if (typeof raw !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/.test(raw))
    throw new Error("Return quantity must be a positive decimal with at most three places");
  const value = new Decimal(raw);
  if (!value.isFinite() || !value.gt(0)) throw new Error("Return quantity must be positive");
  return value;
};
/**
 * Commit contract for the editable allocation UI. This validates the declared
 * demand as well as the actual per-offload quantities before stock mutation.
 * Source legitimacy/stock availability are independently rechecked inside the DB transaction.
 */
export function validateReturnCommitRows(
  rows: ReturnCommitRow[],
  lines: ReturnCommitLine[]
): { totalQty: string; allocatedBySource: Map<number, Decimal> } {
  if (!Array.isArray(rows) || !rows.length || rows.length > 1000)
    throw new Error("Return must have between 1 and 1000 requested rows");
  if (!Array.isArray(lines) || !lines.length || lines.length > 1000)
    throw new Error("Return must contain valid source lines");
  const sourceTotals = new Map<number, Decimal>();
  let total = new Decimal(0);
  for (const row of rows) {
    if (typeof row.code !== "string" || !row.code.trim() || row.code.trim().length > 50)
      throw new Error("Every return row needs a valid article code");
    const expected = positiveQty(row.quantity);
    if (!Array.isArray(row.allocations) || !row.allocations.length)
      throw new Error(`No container allocated to ${row.code}`);
    const seen = new Set<number>();
    let assigned = new Decimal(0);
    for (const allocation of row.allocations) {
      if (!Number.isSafeInteger(allocation.offloadItemId) || allocation.offloadItemId <= 0 ||
          seen.has(allocation.offloadItemId)) throw new Error("Duplicate or invalid source in return row");
      seen.add(allocation.offloadItemId);
      const qty = positiveQty(allocation.quantity);
      assigned = assigned.plus(qty);
      sourceTotals.set(allocation.offloadItemId,
        (sourceTotals.get(allocation.offloadItemId) ?? new Decimal(0)).plus(qty));
    }
    if (!assigned.eq(expected)) throw new Error(`Allocated quantity does not match request for ${row.code}`);
    total = total.plus(expected);
  }
  const posted = new Map<number, Decimal>();
  for (const line of lines) {
    if (!Number.isSafeInteger(line.offloadItemId) || line.offloadItemId <= 0 ||
      posted.has(line.offloadItemId)) throw new Error("Duplicate or invalid posting source");
    posted.set(line.offloadItemId, positiveQty(line.quantity));
  }
  if (sourceTotals.size !== posted.size ||
    [...sourceTotals].some(([id, qty]) => !posted.get(id)?.eq(qty)))
    throw new Error("Posting lines differ from the checked allocation quantities");
  return { totalQty: total.toFixed(3), allocatedBySource: sourceTotals };
}
