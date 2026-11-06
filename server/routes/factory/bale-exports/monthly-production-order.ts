/**
 * Reorder currently active items while retaining hidden inactive item IDs in
 * their existing slots, so reactivation restores their saved layout position.
 *
 * Only company-owned, non-deleted product IDs may be retained.
 */
export function mergeActiveMatrixOrder(
  requested: readonly number[],
  previous: readonly number[],
  activeIds: ReadonlySet<number>,
  companyProductIds: ReadonlySet<number>
): number[] {
  const activeOrder = [...requested];
  const covered = new Set(activeOrder);
  for (const id of previous) {
    if (activeIds.has(id) && !covered.has(id)) {
      activeOrder.push(id);
      covered.add(id);
    }
  }
  for (const id of activeIds) {
    if (!covered.has(id)) {
      activeOrder.push(id);
      covered.add(id);
    }
  }

  const result: number[] = [];
  const seen = new Set<number>();
  let activeIndex = 0;
  for (const id of previous) {
    if (!companyProductIds.has(id)) continue;
    const nextId = activeIds.has(id) ? activeOrder[activeIndex++] : id;
    if (nextId !== undefined && !seen.has(nextId)) {
      result.push(nextId);
      seen.add(nextId);
    }
  }
  for (const id of activeOrder) {
    if (!seen.has(id)) {
      result.push(id);
      seen.add(id);
    }
  }
  return result;
}
