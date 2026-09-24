import type { InventoryItem } from "../pos-components/posTypes";
import { normalizeSearchText } from "@shared/searchNormalization";

export interface POSColumn {
  key: "itemName" | "quantity" | "rate" | "amount" | "plBale" | "totalPL" | "delete";
  label: string;
  width: string;
}

export const POS_COLUMNS: POSColumn[] = [
  { key: "itemName", label: "Item", width: "flex-1" },
  { key: "quantity", label: "Qty", width: "w-20" },
  { key: "rate", label: "Rate", width: "w-24" },
  { key: "amount", label: "Amt", width: "w-28" },
  { key: "plBale", label: "P/L", width: "w-20" },
  { key: "totalPL", label: "T.P/L", width: "w-20" },
  { key: "delete", label: "", width: "w-12" },
];

export function formatDisplayAmount(activeCurrency: string, v: number): string {
  return activeCurrency === "CFA" ? `CFA ${Math.round(v).toLocaleString()}` : `$ ${v.toLocaleString()}`;
}

// Keep POS search normalization in one place so the visible picker and keyboard
// navigation always resolve the exact same item for a highlighted row.
export function normalize(s: string): string {
  return normalizeSearchText(s);
}

export function getFilteredInventory(inventory: InventoryItem[], searchTerm: string): InventoryItem[] {
  if (!searchTerm) return inventory;
  const searchNorm = normalize(searchTerm);
  return inventory.filter(
    (item) => normalize(item.name).includes(searchNorm) || normalize(item.code).includes(searchNorm)
  );
}

export function comparePosItemsByCode(a: InventoryItem, b: InventoryItem): number {
  const codeOrder = a.code.localeCompare(b.code, undefined, {
    numeric: true,
    sensitivity: "base",
  });
  if (codeOrder !== 0) return codeOrder;

  return a.name.localeCompare(b.name, undefined, {
    numeric: true,
    sensitivity: "base",
  });
}

/**
 * Canonical desktop picker list.
 *
 * The old picker sorted independently while keyboard navigation used the raw
 * inventory order. That meant the highlighted item on screen could have a
 * different item at the same array index when Enter/Tab was pressed.
 */
export function getPosPickerInventory(inventory: InventoryItem[], searchTerm: string): InventoryItem[] {
  const filtered = searchTerm
    ? getFilteredInventory(inventory, searchTerm)
    : inventory.filter((item) => item.stock !== 0);

  return [...filtered].sort(comparePosItemsByCode);
}
