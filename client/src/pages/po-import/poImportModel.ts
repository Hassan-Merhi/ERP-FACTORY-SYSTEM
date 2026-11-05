/**
 * Shapes of the parsed PO Import file, the validation result and the per-company
 * draft kept across navigation, plus the merge of server-resolved stock items.
 */
import type React from "react";

export interface POImportItem {
  poNumber: string;
  barcode?: string | null;
  stockItemId?: number | null;
  itemName: string;
  quantity: string | number;
  rate: string | number;
  lineTotal: string | number;
  currency?: string;
}

export interface POImportCharges {
  freight: string | number;
  surcharge: string | number;
  fumigation: string | number;
  discount: string | number;
  documentCharges: string | number;
}

export interface POImportContainer {
  containerNumber: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: string | number;
  grandTotal: string | number;
  charges: POImportCharges;
  items: POImportItem[];
}

export interface POImportPreview {
  fileHash: string;
  fileName: string;
  preview: POImportContainer[];
}

export interface POValidationResult {
  errors: React.ReactNode[];
  resolvedItems?: { index: number; stockItemId: number; itemName: string }[];
}

export interface POImportDraft {
  preview: POImportPreview;
  selectedSupplier: string;
  containerNumber: string;
  importDate: string;
  freightPaidBy: "supplier" | "parent";
  freightParentAccountId: string;
  importCurrency: "" | "USD" | "ZMW";
}

export const draftStorageKey = (companyId: number) => `po-import-draft:${companyId}`;

/** Merge server-resolved names into the parsed file without touching its amounts. */
export function withResolvedStockItems(
  current: POImportPreview | null,
  payload: POImportPayload,
  result: POValidationResult
): POImportPreview | null {
  if (!current || current.fileHash !== payload.fileHash || !result.resolvedItems?.length) return current;
  const resolved = new Map(result.resolvedItems.map((item) => [item.index, item]));
  let changed = false;
  const containers = current.preview.map((container) => {
    if (container.containerNumber !== payload.containerNumber) return container;
    const items = container.items.map((item, index) => {
      const match = resolved.get(index);
      if (!match || (item.itemName === match.itemName && item.stockItemId === match.stockItemId)) return item;
      changed = true;
      return { ...item, itemName: match.itemName, stockItemId: match.stockItemId };
    });
    return changed ? { ...container, items } : container;
  });
  return changed ? { ...current, preview: containers } : current;
}

export type POImportPayload = POImportPreview & {
  containerNumber: string;
  supplierId: number;
  importDate: string;
  exchangeRate?: string;
  /** Explicit invoice currency for a USD/ZMW company; absent elsewhere. */
  currency?: "USD" | "ZMW";
  freightPaidBy: "supplier" | "parent";
  freightParentAccountId: number | null;
};
