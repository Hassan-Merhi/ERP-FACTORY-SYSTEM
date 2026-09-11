import type { InventoryItem } from "../pos-components/posTypes";

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

export function normalize(s: string): string {
  return (s || "").toLowerCase().replace(/[.\-\s]/g, "");
}

export function getFilteredInventory(inventory: InventoryItem[], searchTerm: string): InventoryItem[] {
  if (!searchTerm) return inventory;
  const searchNorm = normalize(searchTerm);
  return inventory.filter(
    (item) => normalize(item.name).includes(searchNorm) || normalize(item.code).includes(searchNorm)
  );
}
