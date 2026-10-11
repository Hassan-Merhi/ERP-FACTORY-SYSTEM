/**
 * Pure helpers and lookup tables for the FactoryPOS page.
 *
 * Extracted from FactoryPOS.tsx during the Phase 4 god-file split.
 */

import type { CartRow } from "./types";

export function emptyRow(id?: string): CartRow {
  return {
    id: id ?? String(Date.now()),
    productId: null,
    productName: "",
    articleCode: "",
    availableQty: 0,
    quantity: 1,
    unitPrice: 0,
    weightPerBale: 0,
  };
}

export function formatNum(v: string | number) {
  const n = parseFloat(String(v));
  if (isNaN(n)) return "0.00";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const COLUMNS = [
  { key: "productName", label: "Description", width: "flex-1" },
  { key: "quantity", label: "Qty", width: "w-20" },
  { key: "unitPrice", label: "Price", width: "w-28" },
  { key: "amount", label: "Amount", width: "w-28" },
  { key: "delete", label: "", width: "w-10" },
];
