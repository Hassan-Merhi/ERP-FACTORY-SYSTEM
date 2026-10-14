/**
 * Types for the DataToolsTab page.
 *
 * Extracted from DataToolsTab.tsx during the Phase 4 god-file split.
 */

export interface SilentImportRow {
  rawCode: string;
  rawName: string;
  stockItemId: number | null;
  stockItemName: string;
  currentQty: number;
  change: number;
  newQty: number;
  rate: number;
  status: "ok" | "not_found" | "to_zero";
}

export interface MergePreviewResult {
  keptItem: { id: number; code: string; name: string; uom: string };
  duplicateItem: { id: number; code: string; name: string; uom: string };
  uomMismatch: boolean;
  inventoryImpact: Array<{
    locationId: number;
    locationName: string;
    keptQty: number;
    keptValue: number;
    keptRate: number;
    dupQty: number;
    dupValue: number;
    dupRate: number;
    combinedQty: number;
    combinedValue: number;
    combinedRate: number;
    action: "combine" | "reassign" | "no_change";
  }>;
  totalValueBefore: number;
  totalValueAfter: number;
  warnings: string[];
}

export type BulkMergePairRow = {
  oldCode: string;
  keepCode: string;
};

export type BulkMergeResult = {
  oldCode: string;
  keepCode: string;
  status: "success" | "skipped" | "error";
  reason?: string;
  keptItemName?: string;
  oldItemName?: string;
};

export interface MergeLogEntry {
  id: number | null;
  keptItemId: number;
  keptItemCode: string;
  keptItemName: string;
  mergedItemId: number;
  mergedItemCode: string;
  mergedItemName: string;
  mergedAt: string;
  notes: string | null;
  source?: "historical";
}
