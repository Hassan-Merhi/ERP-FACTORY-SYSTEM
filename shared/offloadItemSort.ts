/**
 * Consistent A–Z stock-item ordering for individual container offload details.
 * Pure display transform; never reorders or mutates the persisted offload lines.
 */
export interface OffloadSortableItem {
  id: number;
  stockItemId: number;
  stockItemName: string | null;
  stockItemCode: string | null;
}

const itemNameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function offloadItemDisplayName(item: OffloadSortableItem): string {
  return item.stockItemName?.trim() || item.stockItemCode?.trim() || `Item #${item.stockItemId}`;
}

export function sortOffloadItemsByName<T extends OffloadSortableItem>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      itemNameCollator.compare(offloadItemDisplayName(a), offloadItemDisplayName(b)) ||
      a.id - b.id
  );
}
