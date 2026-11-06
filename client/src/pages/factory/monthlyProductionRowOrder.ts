/**
 * Immutable shared-row ordering utilities. All positions are one-based.
 * A position refers to the final order, after the source is removed.
 */
export function moveProductToPosition(
  orderedIds: readonly number[],
  sourceId: number,
  position: number
): number[] {
  if (!orderedIds.includes(sourceId) || !Number.isSafeInteger(position) ||
      position < 1 || position > orderedIds.length) {
    return [...orderedIds];
  }
  const next = orderedIds.filter((id) => id !== sourceId);
  next.splice(position - 1, 0, sourceId);
  return next;
}

export function moveProductNearItem(
  orderedIds: readonly number[],
  sourceId: number,
  targetId: number,
  placement: "before" | "after"
): number[] {
  if (sourceId === targetId || !orderedIds.includes(sourceId) || !orderedIds.includes(targetId)) {
    return [...orderedIds];
  }
  const next = orderedIds.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (placement === "after" ? 1 : 0), 0, sourceId);
  return next;
}
