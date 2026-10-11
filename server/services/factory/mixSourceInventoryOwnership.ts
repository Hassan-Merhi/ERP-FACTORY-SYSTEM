/**
 * Shared helper: resolves the inventory_supplier_id for a factory_mix_batch_sources row.
 *
 * Inventory ownership (which supplier's raw-material kg were consumed) is SEPARATE
 * from pricing ownership (how the source cost is determined). Do not use this to
 * change pricing basis — it only establishes which supplier's timeline is deducted.
 *
 * Rules:
 *  - sourceBatchId present  → null (upstream batch already deducted raw-material kg)
 *  - supplierId present     → supplierId (SUPPLIER_LOCKED_RATE path)
 *  - containerId present    → containerSupplierId (CONTAINER_DIRECT path; caller must resolve)
 *  - none resolvable        → null (caller must reject or surface INVENTORY_SUPPLIER_UNRESOLVED)
 */

export interface MixSourceOwnershipInput {
  supplierId?: number | null;
  containerId?: number | null;
  sourceBatchId?: number | null;
  /** Pre-resolved supplier_id from the container row (required for CONTAINER_DIRECT path). */
  containerSupplierId?: number | null;
}

/**
 * Returns the inventorySupplierId to store on a new factory_mix_batch_sources row.
 * Returns null for BATCH sources (by design) and for sources where no supplier can
 * be resolved.  The caller is responsible for rejecting writes where a non-BATCH source
 * has no resolvable supplier.
 */
export function resolveInventorySupplierId(input: MixSourceOwnershipInput): number | null {
  const { supplierId, containerId, sourceBatchId, containerSupplierId } = input;

  // BATCH sources: upstream batch already handles the raw-material deduction.
  if (sourceBatchId != null) return null;

  // SUPPLIER_LOCKED_RATE path: supplierId is the inventory owner.
  if (supplierId != null) return supplierId;

  // CONTAINER_DIRECT path: the container's own supplier is the inventory owner.
  if (containerId != null && containerSupplierId != null) return containerSupplierId;

  // No resolvable supplier.
  return null;
}

/**
 * Validates that a non-BATCH source has a resolvable inventorySupplierId.
 * Throws a descriptive error rather than silently storing an unowned raw-material source.
 */
export function requireInventorySupplierId(inventorySupplierId: number | null, sourceBatchId?: number | null): void {
  if (sourceBatchId != null) return; // BATCH sources are intentionally null — valid.
  if (inventorySupplierId != null) return; // Resolved — valid.
  throw new Error(
    "INVENTORY_SUPPLIER_UNRESOLVED: cannot create a raw-material source without a " +
      "resolvable supplier. Provide supplierId or ensure the container has a linked supplier."
  );
}
