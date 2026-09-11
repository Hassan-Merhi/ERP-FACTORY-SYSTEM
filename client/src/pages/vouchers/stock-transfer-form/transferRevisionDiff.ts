/**
 * Pure line-by-line diff between a saved stock transfer and the current form
 * entries, keyed by stock item + source location.
 *
 * A revision records what changed, so this is derived data rather than form
 * state: it reads its four inputs and returns the changed lines, which keeps it
 * testable and out of the form model's body.
 */

type SavedTransferItem = {
  stockItemId: number;
  sourceLocationId?: number | null;
  quantity: string;
};

type NamedRecord = { id: number; name?: string | null };

type CurrentEntry = {
  stockItemId?: number | null;
  sourceLocationId?: number | null;
  quantity?: string;
  stockItemName?: string;
  sourceLocationName?: string;
};

export type TransferRevisionDiffLine = {
  stockItemId: number;
  stockItemName: string;
  sourceLocationId: number | null;
  sourceLocationName: string;
  originalQuantity: number;
  delta: number;
  newQuantity: number;
};

/** Lines whose quantity moved by more than a rounding wobble (0.001). */
export function computeTransferRevisionDiff(
  savedItems: SavedTransferItem[] | undefined,
  stockItems: NamedRecord[],
  locations: NamedRecord[],
  currentEntries: CurrentEntry[]
): TransferRevisionDiffLine[] {
  if (!savedItems) return [];

  type RevKey = string;
  const keyOf = (stockItemId: number | null | undefined, sourceLocationId: number | null | undefined): RevKey =>
    `${stockItemId}-${sourceLocationId ?? "null"}`;

  const originalMap = new Map<
    RevKey,
    {
      qty: number;
      stockItemId: number;
      stockItemName: string;
      sourceLocationId: number | null;
      sourceLocationName: string;
    }
  >();
  for (const item of savedItems) {
    const si = stockItems.find((s) => s.id === item.stockItemId);
    const sl = locations.find((l) => l.id === item.sourceLocationId);
    originalMap.set(keyOf(item.stockItemId, item.sourceLocationId), {
      qty: parseFloat(item.quantity) || 0,
      stockItemId: item.stockItemId,
      stockItemName: si?.name || "",
      sourceLocationId: item.sourceLocationId ?? null,
      sourceLocationName: sl?.name || "",
    });
  }

  const currentMap = new Map<RevKey, CurrentEntry>();
  for (const entry of currentEntries) {
    if (!entry.stockItemId || entry.stockItemId <= 0) continue;
    currentMap.set(keyOf(entry.stockItemId, entry.sourceLocationId), entry);
  }

  const result: TransferRevisionDiffLine[] = [];
  for (const key of new Set([...originalMap.keys(), ...currentMap.keys()])) {
    const orig = originalMap.get(key);
    const cur = currentMap.get(key);
    const origQty = orig?.qty ?? 0;
    const curQty = parseFloat(cur?.quantity || "0");
    const delta = curQty - origQty;
    if (Math.abs(delta) < 0.001) continue;
    result.push({
      stockItemId: cur?.stockItemId ?? orig?.stockItemId ?? 0,
      stockItemName: cur?.stockItemName || orig?.stockItemName || "",
      sourceLocationId: cur?.sourceLocationId ?? orig?.sourceLocationId ?? null,
      sourceLocationName: cur?.sourceLocationName || orig?.sourceLocationName || "",
      originalQuantity: origQty,
      delta,
      newQuantity: curQty,
    });
  }
  return result;
}
