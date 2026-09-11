/**
 * Types for the WasteDispatch page.
 *
 * Extracted from WasteDispatch.tsx during the Phase 4 god-file split.
 */

export interface Bale {
  id: number;
  referenceNumber: string;
  productName: string;
  categoryName: string;
  locationName: string;
  weightKg: number;
  totalCost: number;
}

export interface ProductGroup {
  key: string;
  productName: string;
  categoryName: string;
  bales: Bale[];
  totalWeight: number;
  totalCost: number;
  avgRate: number;
}

export interface WasteDispatchHistoryBale {
  id: number;
  referenceNumber: string;
  productName: string;
  weightKg: number | string;
  totalCost: number | string;
}

export interface WasteDispatchHistoryEntry {
  id: number;
  dispatchNumber: string;
  dispatchDate: string;
  notes?: string | null;
  totalBales: number;
  totalWeightKg: number | string;
  totalCostWrittenOff: number | string;
  bales: WasteDispatchHistoryBale[];
}

export interface WasteDispatchPrintData {
  dispatch: { dispatchNumber: string; dispatchDate: string; notes?: string | null };
  bales: Array<Pick<WasteDispatchHistoryBale, "id" | "referenceNumber" | "weightKg" | "totalCost">>;
  totalBales: number;
  totalWeightKg: number | string;
  totalCostWrittenOff: number | string;
}
