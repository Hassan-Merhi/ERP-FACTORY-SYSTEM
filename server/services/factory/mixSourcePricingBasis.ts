/**
 * Shared pricing-basis resolver for factory mix-batch source rows.
 *
 * CRITICAL BUSINESS RULE (spec §3 / §C):
 *   supplierId takes priority over containerId.
 *   A source row that has both supplierId and containerId was created by the
 *   FIFO per-container stock deduction path. The containerId is only FIFO
 *   provenance/quantity attribution. The cost basis is the supplier locked
 *   rate immediately before that batch consumption — NOT the individual
 *   container's own landed rate.
 *
 * Use this resolver everywhere a cost basis decision is made: cascade,
 * mismatch preview, historical replay, and display surfaces.
 */

export type MixSourcePricingBasis =
  | "BATCH"               // sourceBatchId present — upstream batch drives the rate
  | "SUPPLIER_LOCKED_RATE" // supplierId present (± containerId) — supplier historical rate
  | "CONTAINER_DIRECT"    // containerId only, no supplierId — individual container rate
  | "MANUAL_REVIEW";      // none of the above — cannot determine programmatically

export interface MixSourceLike {
  sourceBatchId?: number | null;
  supplierId?: number | null;
  containerId?: number | null;
}

/**
 * Returns the correct pricing basis for a mix-batch source row.
 *
 * Priority (all comparisons are strictly `!= null`):
 *   1. sourceBatchId → BATCH
 *   2. supplierId    → SUPPLIER_LOCKED_RATE  (even when containerId is also set)
 *   3. containerId   → CONTAINER_DIRECT
 *   4. none          → MANUAL_REVIEW
 */
export function resolveMixSourcePricingBasis(source: MixSourceLike): MixSourcePricingBasis {
  if (source.sourceBatchId != null) return "BATCH";
  if (source.supplierId != null) return "SUPPLIER_LOCKED_RATE";
  if (source.containerId != null) return "CONTAINER_DIRECT";
  return "MANUAL_REVIEW";
}

